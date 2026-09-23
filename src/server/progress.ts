import { safeSql } from '@supabase/pg-meta'
import {
  deriveRunPayloadKeys,
  hydrateDataWithKey,
  isEncryptedData,
} from '@workflow/core/serialization-format'
import type { Client } from 'pg'
import { getRun } from 'workflow/api'
import { observabilityRevivers } from 'workflow/observability'
import { getWorld } from 'workflow/runtime'

import { phases } from '../client/contracts'

export function deriveProgress(
  status: string,
  steps: { status: string; output?: unknown; attempt: number; retryAfter?: Date }[]
) {
  let phase: string | null = null,
    revision: string | null = null
  for (const step of steps) {
    if (step.status !== 'completed' || !step.output || typeof step.output !== 'object') continue
    const value = step.output as { state?: unknown; revision?: unknown }
    if (
      typeof value.state !== 'string' ||
      typeof value.revision !== 'string' ||
      !/^\d+$/.test(value.revision) ||
      !['completed', 'cancelled', 'blocked', ...phases.map((p) => p.id)].includes(value.state)
    )
      continue
    if (revision === null || BigInt(value.revision) > BigInt(revision)) {
      phase = value.state
      revision = value.revision
    }
  }
  const pending = steps.find((s) => s.status === 'running' || s.status === 'pending')
  return {
    status,
    phase,
    revision,
    retrying: !!pending && (pending.attempt > 1 || !!pending.retryAfter),
    attempt: pending?.attempt ?? 1,
  }
}
/** Only whitelisted counters and phase names leave this boundary, never step inputs/errors. */
export async function workflowProgress(db: Client, jobId: string, initialRunId: string) {
  let runId = initialRunId
  for (let i = 0; i < 8; i++) {
    const run = getRun<{ jobId: string; state: string; nextRunId?: string }>(runId),
      status = await run.status
    if (status === 'completed') {
      const result = await run.returnValue
      if (result.jobId !== jobId) throw new Error('Workflow job mismatch')
      if (result.nextRunId) {
        await db.query(
          safeSql`UPDATE instant_import_service.browser_jobs SET run_id=$3 WHERE job_id=$1 AND run_id=$2`,
          [jobId, runId, result.nextRunId]
        )
        runId = result.nextRunId
        continue
      }
      return {
        runId,
        status: result.state === 'completed' ? 'completed' : result.state,
        phase: result.state,
        revision: null,
        retrying: false,
        attempt: 1,
        startedAt: (await run.startedAt)?.toISOString() ?? null,
      }
    }
    const world = await getWorld()
    const page = await world.steps.list({
      runId,
      pagination: { limit: 50, sortOrder: 'desc' },
      resolveData: 'all',
    })
    const batches = page.data.filter((s) => s.stepName.endsWith('//processImportBatch'))
    // Hosted step results are encrypted. The synchronous observability hydrator
    // deliberately leaves ciphertext untouched, which used to hide all live progress.
    const needsKey = batches.some((s) => s.status === 'completed' && isEncryptedData(s.output))
    const rawKey = needsKey
      ? await world.getEncryptionKeyForRun?.(await world.runs.get(runId))
      : undefined
    if (needsKey && !rawKey) throw new Error('Could not read encrypted Workflow progress')
    const key = rawKey ? await deriveRunPayloadKeys(rawKey) : undefined
    const steps = await Promise.all(
      batches.map(async (s) => {
        // Only import results are decoded. Inputs and errors may contain private data.
        const output =
          s.status === 'completed'
            ? await hydrateDataWithKey(s.output, observabilityRevivers, key)
            : undefined
        if (s.status === 'completed' && (!output || output instanceof Uint8Array))
          throw new Error('Could not read Workflow progress')
        return {
          status: s.status,
          output,
          attempt: s.attempt,
          retryAfter: s.retryAfter,
        }
      })
    )
    return {
      runId,
      ...deriveProgress(status, steps),
      startedAt: (await run.startedAt)?.toISOString() ?? null,
    }
  }
  return {
    runId,
    status: 'running',
    phase: null,
    revision: null,
    retrying: false,
    attempt: 1,
    startedAt: null,
  }
}
