import { sleep } from 'workflow'
import { start } from 'workflow/api'

import { processImportBatch, recordFailedRun } from './steps'

/** Rotate runs well below Workflow's event limit, regardless of total backup size. */
export async function importBackup(
  jobId: string
): Promise<{ jobId: string; state: string; nextRunId?: string }> {
  'use workflow'
  try {
    for (let i = 0; i < 200; i++) {
      const result = await processImportBatch(jobId)
      if (result.terminal) return { jobId, state: result.state }
      if (result.state === 'busy') await sleep('5s')
    }
    const next = await start(importBackup, [jobId])
    return { jobId, state: 'continuing', nextRunId: next.runId }
  } catch {
    await recordFailedRun(jobId)
    throw new Error('Import run stopped. Restart the job to resume its durable checkpoint.')
  }
}
