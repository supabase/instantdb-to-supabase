import { safeSql } from '@supabase/pg-meta'

import { buildHandoff, handoffPrompt, handoffRule } from '../import/handoff'
import { connectStore, getJob, unpackPlan } from '../workflow/store'
import { jobDestination } from './credentials'
import { workflowProgress } from './progress'
import { errorResponse, HttpError, ownedJob } from './session'

export async function browserHandoff(request: Request, id: string) {
  try {
    const db = await connectStore()
    try {
      const owner = await ownedJob(db, request, id)
      if (!owner.run_id || (await workflowProgress(db, id, owner.run_id)).status !== 'completed')
        throw new HttpError(409, 'The import must finish before you can review its next steps.')
      const job = await getJob(db, id)
      const target = await jobDestination(db, job)
      const projectRef = /^([a-z0-9]{20})\.supabase\.co$/.exec(
        new URL(target.supabaseUrl).hostname
      )?.[1]
      if (!projectRef)
        throw new HttpError(409, 'Project links require a hosted Supabase destination.')
      const report = (
        await db.query(
          safeSql`SELECT bytes FROM instant_import_service.artifacts WHERE job_id=$1 AND name='verification.json'`,
          [id]
        )
      ).rows[0]
      if (!report || !job.model)
        throw new HttpError(409, 'The import results are not ready. Try again shortly.')
      const plan = unpackPlan(job.model)
      const handoff = buildHandoff(plan, {
        projectRef,
        jobId: id,
        permissionsApplied: JSON.parse(report.bytes.toString()).permissionsApplied === true,
        backupDeleted: JSON.parse(report.bytes.toString()).backupDeleted === true,
      })
      const params = new URL(request.url).searchParams
      const item = params.get('item')
      const rule = params.get('rule')
      if (item !== null && rule !== null)
        throw new HttpError(400, 'Request one prompt or rule at a time.')
      if (item !== null && !handoff.items.some((i) => i.id === item))
        throw new HttpError(404, 'Prompt not found')
      if (rule !== null && !handoff.convertedRules.some((r) => r.id === rule))
        throw new HttpError(404, 'Converted rule not found')
      const recordedSql =
        rule !== null && handoff.permissionsApplied
          ? (
              await db.query(
                safeSql`SELECT bytes FROM instant_import_service.artifacts WHERE job_id=$1 AND name='permissions.sql'`,
                [id]
              )
            ).rows[0]?.bytes.toString()
          : undefined
      return Response.json(
        rule !== null
          ? handoffRule(plan, rule, recordedSql)
          : item === null
            ? handoff
            : { prompt: handoffPrompt(plan, handoff, item) },
        { headers: { 'Cache-Control': 'no-store' } }
      )
    } finally {
      await db.end()
    }
  } catch (error) {
    return errorResponse(error)
  }
}
