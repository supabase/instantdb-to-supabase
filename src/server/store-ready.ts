import { safeSql } from '@supabase/pg-meta'
import type { Client } from 'pg'

import { initializeStore } from '../workflow/store'

/**
 * The private schema is created once. Request handlers check for it with a catalog lookup so an
 * ordinary click does not queue ~25 DDL statements behind the global advisory lock.
 */
export async function ensureStore(db: Client) {
  const exists = (
    await db.query(
      safeSql`SELECT to_regclass('instant_import_service.oauth_connections') AS relation, EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='instant_import_service' AND table_name='browser_jobs' AND column_name='telemetry_id') AS telemetry_ready`
    )
  ).rows[0]
  if (!exists?.relation || !exists.telemetry_ready) await initializeStore(db)
}
