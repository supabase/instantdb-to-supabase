import { randomUUID } from 'node:crypto'
import { ident, safeSql } from '@supabase/pg-meta'
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
/** Service-owned database only. No client role can inspect source rows or credentials. */
export async function initializeStore(db: Client) {
  await db.query(safeSql`BEGIN`)
  try {
    await db.query(safeSql`SELECT pg_advisory_xact_lock(1735289202,0)`)
    await db.query(safeSql`CREATE SCHEMA IF NOT EXISTS instant_import_service`)
    await db.query(safeSql`REVOKE ALL ON SCHEMA instant_import_service FROM PUBLIC`)
    await db.query(
      safeSql`CREATE TABLE IF NOT EXISTS instant_import_service.jobs (id uuid PRIMARY KEY, target_ref text NOT NULL, phase text NOT NULL DEFAULT 'uploading', revision bigint NOT NULL DEFAULT 0, cursor jsonb NOT NULL DEFAULT '{"index":0,"after":"","offset":0}', config bytea NOT NULL, model bytea, error_code text, cancel_requested boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`
    )
    await db.query(
      safeSql`CREATE TABLE IF NOT EXISTS instant_import_service.targets (target_ref text PRIMARY KEY, job_id uuid NOT NULL REFERENCES instant_import_service.jobs(id))`
    )
    await db.query(
      safeSql`CREATE TABLE IF NOT EXISTS instant_import_service.files (job_id uuid REFERENCES instant_import_service.jobs(id), id uuid NOT NULL, path text NOT NULL, path_key text NOT NULL, object_key text NOT NULL, size bigint NOT NULL CHECK(size>=0), sha256 text NOT NULL, kind text NOT NULL, namespace text, byte_offset bigint NOT NULL DEFAULT 0, upload_url text, etag text, hash_state bytea, verified boolean NOT NULL DEFAULT false, PRIMARY KEY(job_id,id), UNIQUE(job_id,path_key), UNIQUE(job_id,object_key))`
    )
    await db.query(
      safeSql`CREATE TABLE IF NOT EXISTS instant_import_service.rows (job_id uuid NOT NULL REFERENCES instant_import_service.jobs(id), namespace text NOT NULL, id uuid NOT NULL, raw bytea NOT NULL, normalized bytea NOT NULL, created_at bigint NOT NULL, presence text[] NOT NULL, PRIMARY KEY(job_id,namespace,id))`
    )
    await db.query(
      safeSql`CREATE TABLE IF NOT EXISTS instant_import_service.edges (job_id uuid NOT NULL REFERENCES instant_import_service.jobs(id), link text NOT NULL, source_id uuid NOT NULL, target_id uuid NOT NULL, PRIMARY KEY(job_id,link,source_id,target_id))`
    )
    await db.query(
      safeSql`CREATE INDEX IF NOT EXISTS edges_reverse ON instant_import_service.edges(job_id,link,target_id,source_id)`
    )
    await db.query(
      safeSql`CREATE TABLE IF NOT EXISTS instant_import_service.unique_values (job_id uuid NOT NULL REFERENCES instant_import_service.jobs(id), namespace text NOT NULL, field text NOT NULL, digest text NOT NULL, value bytea NOT NULL, entity_id uuid NOT NULL)`
    )
    await db.query(
      safeSql`CREATE INDEX IF NOT EXISTS unique_lookup ON instant_import_service.unique_values(job_id,namespace,field,digest)`
    )
    await db.query(
      safeSql`CREATE TABLE IF NOT EXISTS instant_import_service.blobs (job_id uuid NOT NULL REFERENCES instant_import_service.jobs(id), id uuid NOT NULL, source_file uuid NOT NULL, metadata bytea NOT NULL, size bigint NOT NULL, included boolean NOT NULL DEFAULT true, PRIMARY KEY(job_id,id))`
    )
    await db.query(
      safeSql`CREATE TABLE IF NOT EXISTS instant_import_service.transfers (job_id uuid NOT NULL REFERENCES instant_import_service.jobs(id), id uuid NOT NULL, upload_url text, byte_offset bigint NOT NULL DEFAULT 0, verified_byte_offset bigint NOT NULL DEFAULT 0, hash_state bytea, storage_id uuid, storage_version text, PRIMARY KEY(job_id,id))`
    )
    await db.query(
      safeSql`CREATE TABLE IF NOT EXISTS instant_import_service.artifacts (job_id uuid NOT NULL REFERENCES instant_import_service.jobs(id), name text NOT NULL, bytes bytea NOT NULL, PRIMARY KEY(job_id,name))`
    )
    await db.query(
      safeSql`CREATE TABLE IF NOT EXISTS instant_import_service.browser_jobs (job_id uuid PRIMARY KEY REFERENCES instant_import_service.jobs(id) ON DELETE CASCADE, session_hash text NOT NULL, target_encrypted bytea NOT NULL, file_count integer NOT NULL, selection_hash text NOT NULL, run_id text, created_at timestamptz NOT NULL DEFAULT now())`
    )
    await db.query(
      safeSql`CREATE TABLE IF NOT EXISTS instant_import_service.oauth_states (state_hash text PRIMARY KEY, session_hash text NOT NULL, cookie_hash text NOT NULL, verifier bytea NOT NULL, expires_at timestamptz NOT NULL)`
    )
    await db.query(
      safeSql`CREATE TABLE IF NOT EXISTS instant_import_service.oauth_connections (session_hash text PRIMARY KEY, tokens bytea NOT NULL, expires_at timestamptz NOT NULL)`
    )
    await db.query(
      safeSql`CREATE TABLE IF NOT EXISTS instant_import_service.oauth_database_credentials (session_hash text NOT NULL REFERENCES instant_import_service.oauth_connections(session_hash) ON DELETE CASCADE, project_ref text NOT NULL, credential bytea NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(session_hash,project_ref))`
    )
    await db.query(
      safeSql`CREATE TABLE IF NOT EXISTS instant_import_service.platform_cooldowns (scope text PRIMARY KEY, retry_at timestamptz NOT NULL, failures integer NOT NULL, status integer NOT NULL)`
    )
    await db.query(
      safeSql`ALTER TABLE instant_import_service.browser_jobs ADD COLUMN IF NOT EXISTS telemetry_id uuid`
    )
    for (const table of [
      'platform_cooldowns',
      'oauth_database_credentials',
      'oauth_states',
      'oauth_connections',
      'browser_jobs',
      'jobs',
      'targets',
      'files',
      'rows',
      'edges',
      'unique_values',
      'blobs',
      'transfers',
      'artifacts',
    ])
      await db.query(
        safeSql`ALTER TABLE instant_import_service.${ident(table)} ENABLE ROW LEVEL SECURITY`
      )
    await db.query(
      safeSql`ALTER TABLE instant_import_service.transfers ADD COLUMN IF NOT EXISTS storage_version text`
    )
    await db.query(
      safeSql`REVOKE ALL ON SCHEMA instant_import_service FROM PUBLIC, anon, authenticated`
    )
    await db.query(
      safeSql`REVOKE ALL ON ALL TABLES IN SCHEMA instant_import_service FROM PUBLIC, anon, authenticated`
    )
    await db.query(safeSql`COMMIT`)
  } catch (error) {
    await db.query(safeSql`ROLLBACK`)
    throw error
  }
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
