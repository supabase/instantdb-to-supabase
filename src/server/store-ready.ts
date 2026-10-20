import { safeSql } from '@supabase/pg-meta'
import type { Client } from 'pg'

import { sourceBucket } from '../workflow/source'
import { HttpError } from './session'

const unavailable = () =>
  new HttpError(503, 'The import service is not set up yet. Try again later.')
let ready = false
/**
 * The service schema is owned by supabase/migrations, never created at runtime. A catalog lookup
 * confirms the latest migrations are applied; once confirmed, this instance stops checking.
 */
export async function ensureStore(db: Client) {
  if (ready) return
  const row = (
    await db.query(
      safeSql`SELECT to_regclass('instant_import_service.oauth_connections') IS NOT NULL AND to_regclass('public.usage_events') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='instant_import_service' AND table_name='browser_jobs' AND column_name='telemetry_id') AS ready`
    )
  ).rows[0]
  if (!row?.ready) {
    console.error(
      'Import service schema is missing or outdated. Apply supabase/migrations to the service project (supabase db push).'
    )
    throw unavailable()
  }
  ready = true
}
/**
 * The upload bucket is also owned by supabase/migrations. Privacy is a security property, so it is
 * checked on every job rather than cached: a bucket flipped to public stops new uploads.
 */
export async function ensureSourceBucket(db: Client) {
  const row = (
    await db.query(safeSql`SELECT public FROM storage.buckets WHERE id=$1`, [sourceBucket])
  ).rows[0]
  if (!row) {
    console.error(
      'Import upload bucket is missing. Apply supabase/migrations to the service project (supabase db push).'
    )
    throw unavailable()
  }
  if (row.public !== false) throw new Error('Source bucket must be private')
}
