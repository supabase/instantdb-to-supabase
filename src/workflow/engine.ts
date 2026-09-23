import { safeSql } from '@supabase/pg-meta'

import { schemaFingerprint } from '../import/fingerprint'
import { migrationFile, verifyMigration } from '../import/migrations'
import { compilePermissions, permissionsManual, permissionsSql } from '../import/permissions'
import { qualified } from '../import/sql'
import { PlatformRetryError } from '../platform-retry'
import { connectJobTarget } from '../server/credentials'
import { captureJobProgress } from '../telemetry/server'
import { cleanupBackup, cleanupTarget } from './cleanup'
import { importAuth, importFile } from './native'
import { applyPermissionMigration, verifiedPermissionMigration } from './permissions'
import { analyzePage, validatePage } from './staging'
import { advance, connectStore, getJob, unpackPlan, type Job } from './store'
import {
  assertOwner,
  constrain,
  createTarget,
  importLinks,
  importRows,
  targetBatch,
  targetSchema,
} from './target'
import { finalConstraints, initialApplicationSchema } from './target-schema'

export type StepResult = { state: string; revision: string; terminal: boolean }
/**
 * Refusals that the identical immutable input reproduces on every attempt. Retrying one only
 * burns the step's retry budget, so callers surface it instead of scheduling another attempt.
 */
const deterministicFailures = new Set([
  'Another job owns this target',
  'Batch receipt conflict',
  'Destination ownership or schema drift',
  'Input has not been frozen',
])
/** Only messages this pipeline authored travel outward; driver text never leaves the step. */
export class ImportStepError extends Error {
  constructor(
    message: string,
    readonly fatal: boolean
  ) {
    super(message)
    this.name = 'ImportStepError'
  }
}
export async function executeImportStep(
  id: string,
  afterTargetCommit?: () => Promise<void>,
  onError?: (error: unknown) => void
): Promise<StepResult> {
  const service = await connectStore()
  let job: Job | undefined
  try {
    if (
      !(
        await service.query(
          safeSql`SELECT pg_try_advisory_lock(hashtextextended($1,1735289202)) AS acquired`,
          [id]
        )
      ).rows[0].acquired
    )
      return { state: 'busy', revision: '0', terminal: false }
    job = await getJob(service, id)
    if (['completed', 'blocked', 'cancelled'].includes(job.phase)) {
      await captureJobProgress(service, id, job.phase)
      return { state: job.phase, revision: job.revision, terminal: true }
    }
    if (job.phase === 'uploading') throw new Error('Input has not been frozen')
    await service.query(safeSql`BEGIN`)
    try {
      await service.query(
        safeSql`INSERT INTO instant_import_service.targets(target_ref,job_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [job.target_ref, id]
      )
      if (
        (
          await service.query(
            safeSql`SELECT job_id FROM instant_import_service.targets WHERE target_ref=$1`,
            [job.target_ref]
          )
        ).rows[0].job_id !== id
      )
        throw new Error('Another job owns this target')
      if (job.cancel_requested && job.phase !== 'cleanup') {
        if (['analyzing', 'validating'].includes(job.phase))
          await service.query(safeSql`DELETE FROM instant_import_service.targets WHERE job_id=$1`, [
            id,
          ])
        await advance(service, job, 'cancelled')
      } else if (job.phase === 'analyzing') await analyzePage(service, job)
      else if (job.phase === 'validating') await validatePage(service, job)
      else if (job.phase === 'cleanup' && job.cursor.index > 0) await cleanupBackup(service, job)
      else {
        const plan = unpackPlan(job.model!),
          { target, db } = await connectJobTarget(service, job)
        try {
          if (!['schema', 'cleanup'].includes(job.phase)) await assertOwner(db, job, plan)
          switch (job.phase) {
            case 'cleanup':
              await cleanupTarget(service, db, job, plan)
              break
            case 'schema':
              await createTarget(service, db, job, plan)
              break
            case 'auth':
              await importAuth(service, db, job, plan, target)
              break
            case 'files':
              await importFile(service, db, job, plan, target)
              break
            case 'rows':
              await importRows(service, db, job, plan)
              break
            case 'links':
              await importLinks(service, db, job, plan)
              break
            case 'constraints':
              await constrain(service, db, job, plan)
              break
            case 'verify_links':
              await importLinks(service, db, job, plan, true)
              break
            case 'verifying':
              await importRows(service, db, job, plan, true)
              break
            case 'reports': {
              const schema = targetSchema(plan)
              const state = (
                await db.query(
                  safeSql`SELECT migration_version FROM ${qualified(schema, 'restore_job')}`
                )
              ).rows[0]
              const baseline = {
                version: state.migration_version,
                name: `import_schema_${plan.contentHash.slice(0, 12)}`,
                fileName: '',
                statements: initialApplicationSchema(plan),
              }
              baseline.fileName = `${baseline.version}_${baseline.name}.sql`
              await verifyMigration(db, baseline)
              const artifacts: Record<string, Buffer> = {
                [`migrations/${baseline.fileName}`]: Buffer.from(migrationFile(baseline)),
              }
              const constraints = finalConstraints(plan)
              for (const [index, statement] of constraints.entries()) {
                const name = `import_constraints_${plan.contentHash.slice(0, 12)}_${index}`
                const versions = (
                  await db.query(
                    safeSql`SELECT version FROM supabase_migrations.schema_migrations WHERE name=$1`,
                    [name]
                  )
                ).rows
                if (versions.length !== 1) throw new Error('Constraint migration history drift')
                const migration = {
                  name,
                  version: versions[0].version,
                  fileName: `${versions[0].version}_${name}.sql`,
                  statements: [statement],
                }
                await verifyMigration(db, migration)
                artifacts[`migrations/${migration.fileName}`] = Buffer.from(
                  migrationFile(migration)
                )
              }
              await targetBatch(
                db,
                job,
                plan,
                async () => {
                  await applyPermissionMigration(db, plan)
                  await db.query(
                    safeSql`UPDATE ${qualified(schema, 'restore_job')} SET state='restored_setup_required',data_loaded=true,revision=revision+1 WHERE id`
                  )
                },
                true
              )
              const security = await verifiedPermissionMigration(db, plan)
              artifacts[`migrations/${security.fileName}`] = Buffer.from(migrationFile(security))
              const permissions = { ...compilePermissions(plan), applied: true }
              artifacts['permissions.sql'] = Buffer.from(permissionsSql(permissions))
              artifacts['permissions.json'] = Buffer.from(
                JSON.stringify({ ...permissions, statements: undefined }, null, 2)
              )
              artifacts['permissions-manual.md'] = Buffer.from(permissionsManual(permissions))
              artifacts['verification.json'] = Buffer.from(
                JSON.stringify(
                  {
                    state: 'restored_setup_required',
                    contentHash: plan.contentHash,
                    verified: plan.totals,
                    sourceTotals: plan.sourceTotals,
                    permissions: permissions.summary,
                    permissionsApplied: true,
                  },
                  null,
                  2
                )
              )
              for (const [name, bytes] of Object.entries(artifacts))
                await service.query(
                  safeSql`INSERT INTO instant_import_service.artifacts(job_id,name,bytes) VALUES($1,$2,$3) ON CONFLICT(job_id,name) DO UPDATE SET bytes=excluded.bytes`,
                  [id, name, bytes]
                )
              await advance(service, job, 'cleanup', {
                index: 0,
                after: await schemaFingerprint(db, 'public'),
                offset: 0,
              })
              break
            }
            default:
              throw new Error('Unsupported job phase')
          }
          await afterTargetCommit?.()
        } finally {
          await db.end()
        }
      }
      await service.query(safeSql`COMMIT`)
    } catch (error) {
      // A failed rollback (dead connection) must not replace the failure that caused it.
      await service.query(safeSql`ROLLBACK`).catch(() => {})
      throw error
    }
    const next = await getJob(service, id)
    if (next.phase !== job.phase) await captureJobProgress(service, id, next.phase)
    return {
      state: next.phase,
      revision: next.revision,
      terminal: ['completed', 'blocked', 'cancelled'].includes(next.phase),
    }
  } catch (error) {
    onError?.(error)
    // No source rows, SQL parameters, tokens, or nested driver causes leave the step.
    if (job)
      await service
        .query(
          safeSql`UPDATE instant_import_service.jobs SET error_code='STEP_FAILED',updated_at=now() WHERE id=$1`,
          [id]
        )
        .catch(() => {})
    if (error instanceof PlatformRetryError) throw error
    const message = error instanceof Error ? error.message : ''
    if (deterministicFailures.has(message)) throw new ImportStepError(message, true)
    throw new ImportStepError(
      'Import step failed. Inspect the job and retry with the same immutable input.',
      false
    )
  } finally {
    await service.end()
  }
}
