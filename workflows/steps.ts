import { safeSql } from '@supabase/pg-meta'
import { FatalError, RetryableError } from 'workflow'

import { PlatformRetryError } from '../src/platform-retry'
import { captureJobProgress } from '../src/telemetry/server'
import { executeImportStep, ImportStepError } from '../src/workflow/engine'
import { connectStore } from '../src/workflow/store'

export async function processImportBatch(jobId: string) {
  'use step'
  try {
    return await executeImportStep(jobId)
  } catch (error) {
    // The engine already sanitized its own messages; anything else stays generic.
    const message =
      error instanceof ImportStepError || error instanceof PlatformRetryError
        ? error.message
        : 'Import batch did not complete. The durable checkpoint is retained.'
    // Deterministic refusals reproduce on every attempt, so spending retries only hides them.
    if (error instanceof ImportStepError && error.fatal) throw new FatalError(message)
    throw new RetryableError(message, {
      retryAfter: error instanceof PlatformRetryError ? new Date(error.retryAt) : '10s',
    })
  }
}
processImportBatch.maxRetries = 5

export async function recordFailedRun(jobId: string) {
  'use step'
  const db = await connectStore()
  try {
    // Do not overwrite progress made by another run after this run's last failure.
    const result = await db.query(
      safeSql`UPDATE instant_import_service.jobs SET error_code='RUN_FAILED',updated_at=now() WHERE id=$1 AND error_code='STEP_FAILED' RETURNING phase`,
      [jobId]
    )
    if (result.rows[0]) await captureJobProgress(db, jobId, result.rows[0].phase, true)
  } finally {
    await db.end()
  }
}
