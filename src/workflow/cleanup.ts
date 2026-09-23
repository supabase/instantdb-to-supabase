import { ident, safeSql } from '@supabase/pg-meta'
import type { Client } from 'pg'

import { schemaFingerprint } from '../import/fingerprint'
import { removeImportState } from '../import/sql'
import type { Plan } from '../import/types'
import { removeSourceObjects } from './source'
import { advance, packPlan, unpackPlan, type Job } from './store'
import { assertOwner, targetSchema } from './target'

/** Reports and the public fingerprint are committed to the service before this step. */
export async function cleanupTarget(service: Client, db: Client, job: Job, plan: Plan) {
  if (job.phase !== 'cleanup' || !job.cursor.after) throw new Error('Cleanup checkpoint is missing')
  if ((await schemaFingerprint(db, 'public')) !== job.cursor.after)
    throw new Error('Destination changed before import cleanup')
  const schema = targetSchema(plan)
  await db.query(safeSql`BEGIN`)
  try {
    if ((await db.query(safeSql`SELECT 1 FROM pg_namespace WHERE nspname=$1`, [schema])).rowCount) {
      await assertOwner(db, job, plan)
      // RESTRICT is intentional: unexpected dependencies must block cleanup, not disappear.
      for (const statement of removeImportState(schema, true)) await db.query(statement)
    }
    await db.query(safeSql`COMMIT`)
  } catch (error) {
    await db.query(safeSql`ROLLBACK`)
    throw error
  }
  // A lost service commit can safely retry: no further import writes depend on this schema.
  await advance(service, job, 'cleanup', { ...job.cursor, index: 1 })
}

/** Keep only schema/rule context needed by the owner's completion prompts. */
export function completionModel(plan: Plan): Plan {
  const config = JSON.parse(plan.config.toString())
  const retained: Record<string, unknown> = { rules: config.rules }
  for (const key of ['webhooks', 'emailTemplates', 'authorizedRedirectOrigins'])
    if (config[key] !== undefined)
      retained[key] = '[Read this configuration privately from local config.json]'
  return {
    ...plan,
    config: Buffer.from(JSON.stringify(retained)),
    namespaces: plan.namespaces.map((namespace) => ({ ...namespace, rows: [] })),
    links: plan.links.map((link) => ({ ...link, edges: [] })),
    files: [],
  }
}

const stagingTables = ['rows', 'edges', 'unique_values', 'blobs', 'transfers'] as const

/** Runs under the job lock and service transaction, without a destination connection. */
export async function cleanupBackup(service: Client, job: Job) {
  const index = job.cursor.index
  if (job.phase !== 'cleanup' || !job.cursor.after || index < 1 || index > 7)
    throw new Error('Backup cleanup checkpoint is missing')
  if (index === 1) {
    const files = (
      await service.query(
        safeSql`SELECT id,object_key FROM instant_import_service.files WHERE job_id=$1 ORDER BY id LIMIT 100`,
        [job.id]
      )
    ).rows
    if (files.length) {
      // Storage deletion is idempotent. Keep the manifest until it succeeds so a lost
      // transaction or partial Storage failure retries exactly the same objects.
      await removeSourceObjects(files.map((file) => file.object_key))
      await service.query(
        safeSql`DELETE FROM instant_import_service.files WHERE job_id=$1 AND id=ANY($2::uuid[])`,
        [job.id, files.map((file) => file.id)]
      )
    }
    await advance(service, job, 'cleanup', { ...job.cursor, index: files.length ? 1 : 2 })
    return
  }
  const table = stagingTables[index - 2]
  if (table) {
    const result = await service.query(
      safeSql`DELETE FROM instant_import_service.${ident(table)} WHERE job_id=$1 AND ctid IN (SELECT ctid FROM instant_import_service.${ident(table)} WHERE job_id=$1 LIMIT 1000)`,
      [job.id]
    )
    await advance(service, job, 'cleanup', {
      ...job.cursor,
      index: result.rowCount ? index : index + 1,
    })
    return
  }
  await service.query(
    safeSql`UPDATE instant_import_service.jobs SET config=$2,model=$3 WHERE id=$1`,
    [job.id, Buffer.alloc(0), packPlan(completionModel(unpackPlan(job.model!)))]
  )
  await service.query(
    safeSql`UPDATE instant_import_service.artifacts SET bytes=convert_to((convert_from(bytes,'UTF8')::jsonb || jsonb_build_object('backupDeleted',true))::text,'UTF8') WHERE job_id=$1 AND name='verification.json'`,
    [job.id]
  )
  await advance(service, job, 'completed')
}
