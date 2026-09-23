import { safeSql } from '@supabase/pg-meta'
import { start } from 'workflow/api'
import { z } from 'zod'

import { authorized } from '../../../../src/workflow/api-auth'
import { connectStore, getJob } from '../../../../src/workflow/store'
import { importBackup } from '../../../../workflows/import-backup'

export const maxDuration = 300
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!authorized(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await context.params
  if (!z.string().uuid().safeParse(id).success)
    return Response.json({ error: 'Invalid job ID' }, { status: 400 })
  const db = await connectStore()
  try {
    const job = await getJob(db, id)
    if (job.phase === 'uploading')
      return Response.json({ error: 'Complete and freeze the input first' }, { status: 409 })
    if (['completed', 'cancelled', 'blocked'].includes(job.phase))
      return Response.json({ jobId: id, state: job.phase })
    // Concurrent starts may create extra runs; the service lock and destination
    // receipts serialize their work and prevent duplicate side effects.
    const run = await start(importBackup, [id])
    return Response.json({ jobId: id, runId: run.runId }, { status: 202 })
  } catch (error) {
    return requestError(error)
  } finally {
    await db.end()
  }
}
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!authorized(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await context.params
  if (!z.string().uuid().safeParse(id).success)
    return Response.json({ error: 'Invalid job ID' }, { status: 400 })
  const db = await connectStore()
  try {
    const job = await getJob(db, id)
    return Response.json({
      jobId: id,
      state: job.error_code === 'RUN_FAILED' ? 'failed' : job.phase,
      phase: job.phase,
      revision: job.revision,
      errorCode: job.error_code,
      cancelRequested: job.cancel_requested,
    })
  } catch (error) {
    return requestError(error)
  } finally {
    await db.end()
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!authorized(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await context.params
  if (!z.string().uuid().safeParse(id).success)
    return Response.json({ error: 'Invalid job ID' }, { status: 400 })
  const db = await connectStore()
  try {
    const result = await db.query(
      safeSql`UPDATE instant_import_service.jobs SET cancel_requested=true,updated_at=now(),phase=CASE WHEN phase='uploading' THEN 'cancelled' ELSE phase END WHERE id=$1 RETURNING phase`,
      [id]
    )
    if (!result.rowCount) return Response.json({ error: 'Import job not found' }, { status: 404 })
    if (!['completed', 'cancelled', 'blocked'].includes(result.rows[0].phase))
      await start(importBackup, [id])
    return Response.json({ jobId: id, cancelRequested: true }, { status: 202 })
  } catch (error) {
    return requestError(error)
  } finally {
    await db.end()
  }
}

function requestError(error: unknown) {
  if (error instanceof Error && error.message === 'Import job not found')
    return Response.json({ error: 'Import job not found' }, { status: 404 })
  return Response.json(
    { error: 'Import request failed. Retry using the same job ID.' },
    { status: 503 }
  )
}
