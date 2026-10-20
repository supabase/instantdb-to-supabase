import { randomUUID } from 'node:crypto'
import { safeSql } from '@supabase/pg-meta'
import { Client } from 'pg'

import type { Plan } from '../import/types'
import { supabaseDatabaseCa } from './supabase-ca'

export type Phase =
  | 'uploading'
  | 'analyzing'
  | 'validating'
  | 'schema'
  | 'auth'
  | 'files'
  | 'rows'
  | 'links'
  | 'constraints'
  | 'verify_links'
  | 'reports'
  | 'cleanup'
  | 'verifying'
  | 'completed'
  | 'blocked'
  | 'cancelled'
export type Job = {
  id: string
  target_ref: string
  phase: Phase
  revision: string
  cursor: { index: number; after: string; offset: number }
  config: Buffer
  model: Buffer | null
  error_code: string | null
  cancel_requested: boolean
}
export type SourceFile = {
  id: string
  path: string
  object_key: string
  size: string
  sha256: string
  namespace: string | null
  kind: 'config' | 'entity' | 'blob' | 'ignored'
  byte_offset: string
  etag: string | null
  hash_state: Buffer | null
  verified: boolean
}
export function packPlan(plan: Plan) {
  return Buffer.from(JSON.stringify({ ...plan, config: plan.config.toString('base64') }))
}
export function unpackPlan(bytes: Buffer): Plan {
  const value = JSON.parse(bytes.toString())
  return { ...value, config: Buffer.from(value.config, 'base64') }
}
export function storeConnectionOptions(connectionString: string) {
  const url = new URL(connectionString)
  if (!/^(?:db\.[a-z0-9]{20}\.supabase\.co|[a-z0-9-]+\.pooler\.supabase\.com)$/.test(url.hostname))
    return { connectionString }
  // pg replaces its SSL object when the URL contains SSL options. Use the hosted CA
  // and hostname verification explicitly, including when an operator copies sslmode=require.
  for (const key of ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey'])
    url.searchParams.delete(key)
  return {
    connectionString: url.href,
    ssl: { ca: supabaseDatabaseCa, rejectUnauthorized: true },
  }
}
export async function connectStore(url = process.env.IMPORT_JOB_DATABASE_URL) {
  if (!url) throw new Error('Configure IMPORT_JOB_DATABASE_URL')
  const db = new Client({
    ...storeConnectionOptions(url),
    connectionTimeoutMillis: 10_000,
    query_timeout: 120_000,
  })
  await db.connect()
  return db
}
export async function createJob(db: Client, targetRef: string, config: Buffer) {
  const id = randomUUID()
  await db.query(
    safeSql`INSERT INTO instant_import_service.jobs(id,target_ref,config) VALUES ($1,$2,$3)`,
    [id, targetRef, config]
  )
  return id
}
export async function getJob(db: Client, id: string): Promise<Job> {
  const result = await db.query(safeSql`SELECT * FROM instant_import_service.jobs WHERE id=$1`, [
    id,
  ])
  if (!result.rowCount) throw new Error('Import job not found')
  return result.rows[0]
}
export async function advance(
  db: Client,
  job: Job,
  phase: Phase,
  cursor = { index: 0, after: '', offset: 0 }
) {
  const result = await db.query(
    safeSql`UPDATE instant_import_service.jobs SET phase=$2,cursor=$3,revision=revision+1,updated_at=now(),error_code=NULL WHERE id=$1 AND revision=$4 RETURNING id`,
    [job.id, phase, JSON.stringify(cursor), job.revision]
  )
  if (result.rowCount !== 1) throw new Error('Stale job revision')
}
