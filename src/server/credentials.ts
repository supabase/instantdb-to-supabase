import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { safeSql } from '@supabase/pg-meta'
import type { Client } from 'pg'
import { z } from 'zod'

import { connectionSchema, type Connection } from '../client/contracts'
import type { Job } from '../workflow/store'
import { connectTargetWithRefresh, resolveTarget } from '../workflow/target'
import { resolveOAuthTarget } from './oauth'
import { HttpError } from './session'

function key() {
  const value = Buffer.from(process.env.IMPORT_CREDENTIAL_KEY ?? '', 'base64')
  if (value.length !== 32) throw new Error('Configure a 32-byte IMPORT_CREDENTIAL_KEY')
  return value
}
export function encryptSecret(jobId: string, target: unknown) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(), iv)
  cipher.setAAD(Buffer.from(jobId))
  const serialized = JSON.stringify(target)
  if (serialized === undefined) throw new Error('Cannot encrypt an undefined value')
  const bytes = Buffer.concat([cipher.update(serialized), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), bytes])
}
export function decryptSecret(jobId: string, value: Buffer): unknown {
  if (value.length < 12 + 16 + 1) throw new Error('Invalid ciphertext')
  const decipher = createDecipheriv('aes-256-gcm', key(), value.subarray(0, 12))
  decipher.setAAD(Buffer.from(jobId))
  decipher.setAuthTag(value.subarray(12, 28))
  return JSON.parse(
    Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString()
  )
}
const oauthReferenceSchema = z
  .object({ mode: z.literal('oauth'), projectRef: z.string().regex(/^[a-z0-9]{20}$/) })
  .strict()
const storedTargetSchema = z.union([oauthReferenceSchema, connectionSchema])
type StoredTarget = z.infer<typeof storedTargetSchema>
export function encryptTarget(jobId: string, target: StoredTarget) {
  return encryptSecret(jobId, target)
}
export function decryptTarget(jobId: string, value: Buffer): StoredTarget {
  return storedTargetSchema.parse(decryptSecret(jobId, value))
}
export function validateConnection(input: unknown, allowLocal: boolean): Connection {
  const target = connectionSchema.parse(input),
    db = new URL(target.databaseUrl),
    api = new URL(target.supabaseUrl)
  if (
    !['postgres:', 'postgresql:'].includes(db.protocol) ||
    !db.username ||
    !db.password ||
    db.hash ||
    api.username ||
    api.password ||
    api.search ||
    api.hash ||
    !['', '/'].includes(api.pathname)
  )
    throw new Error('Invalid destination connection')
  for (const [name, value] of db.searchParams)
    if (name !== 'sslmode' || !['require', 'verify-full'].includes(value))
      throw new Error('Unsupported connection option')
  const local = ['localhost', '127.0.0.1'].includes(db.hostname)
  if (local) {
    if (
      !allowLocal ||
      !['localhost', '127.0.0.1'].includes(api.hostname) ||
      !['http:', 'https:'].includes(api.protocol) ||
      Number(db.port) !== Number(api.port) + 1
    )
      throw new Error('Local destinations are not enabled or the API port does not match')
  } else {
    const ref = /^([a-z0-9]{20})\.supabase\.co$/.exec(api.hostname)?.[1]
    const direct = db.hostname === `db.${ref}.supabase.co`
    const pooler =
      /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(db.hostname) &&
      decodeURIComponent(db.username) === `postgres.${ref}`
    if (
      !ref ||
      api.protocol !== 'https:' ||
      api.port ||
      (!direct && !pooler) ||
      (db.port && db.port !== '5432')
    )
      throw new Error('Use matching Supabase project URLs and a direct or session connection')
  }
  return { ...target, supabaseUrl: api.origin }
}
async function storedTarget(db: Client, job: Job) {
  if (!job.target_ref.startsWith('ui:')) return { target: resolveTarget(job.target_ref), owner: '' }
  const result = await db.query(
    safeSql`SELECT target_encrypted,session_hash FROM instant_import_service.browser_jobs WHERE job_id=$1`,
    [job.id]
  )
  if (!result.rows[0]) throw new HttpError(404, 'Import destination is unavailable')
  return {
    target: decryptTarget(job.id, result.rows[0].target_encrypted),
    owner: result.rows[0].session_hash as string,
  }
}
export async function jobDestination(db: Client, job: Job) {
  const { target } = await storedTarget(db, job)
  return {
    supabaseUrl: 'mode' in target ? `https://${target.projectRef}.supabase.co` : target.supabaseUrl,
  }
}
export async function jobTarget(db: Client, job: Job, force = false) {
  const { target, owner } = await storedTarget(db, job)
  return 'mode' in target ? resolveOAuthTarget(owner, target.projectRef, force) : target
}
export async function connectJobTarget(db: Client, job: Job) {
  return connectTargetWithRefresh((force) => jobTarget(db, job, force))
}
