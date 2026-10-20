import { randomUUID } from 'node:crypto'
import { safeSql } from '@supabase/pg-meta'
import type { Client } from 'pg'
import { z } from 'zod'

import { projectRefSchema } from '../server/oauth-client'
import { connectStore } from '../workflow/store'
import { browserEventSchema, progressStageSchema } from './contracts'

/**
 * First-party usage log in the private service project. Unlike PostHog it is not gated on
 * analytics configuration or cookies and survives content blockers. It stores no identifier for a
 * person or browser: no cookie, session hash, IP address, or user agent. Properties are counts and
 * enums only; never add messages, paths, SQL, URLs, credentials, or source data.
 */
const count = z.number().int().nonnegative().safe()
const event = <A extends string, P extends z.ZodRawShape>(action: A, properties: P) =>
  z.object({ action: z.literal(action), properties: z.object(properties).strict() }).strict()
const totals = z
  .object({ namespaces: count, rows: count, edges: count, files: count, bytes: count })
  .strict()
export const completionStatsSchema = z
  .object({
    verified: totals,
    source: totals,
    permissions: z.object({ converted: count, manual: count, excluded: count }).strict(),
  })
  .strict()
const progress = {
  importStage: progressStageSchema,
  elapsedMs: count,
  errorCode: z.enum(['STEP_FAILED', 'RUN_FAILED']).optional(),
}
const serverEventSchema = z.discriminatedUnion('action', [
  event('instant_import_preflight_failed', {}),
  event('instant_import_job_created', { fileCount: count.max(10000) }),
  event('instant_import_upload_completed', {
    fileCount: count.max(10000),
    totalBytes: count,
    entityFiles: count,
    blobFiles: count,
  }),
  event('instant_import_stage_updated', progress),
  event('instant_import_completed', { ...progress, stats: completionStatsSchema.optional() }),
  event('instant_import_failed', progress),
  event('instant_import_closed', progress),
  event('instant_import_connection_completed', { connectionResult: z.literal('connected') }),
  event('instant_import_connection_failed', { connectionResult: z.enum(['denied', 'error']) }),
])
export const usageEventSchema = z.union([serverEventSchema, browserEventSchema])
export type UsageEvent = z.infer<typeof usageEventSchema>
export type UsageContext = { jobId?: string | null; targetRef?: string | null }

const contextSchema = z
  .object({
    jobId: z.string().uuid().nullish(),
    targetRef: projectRefSchema.nullish(),
  })
  .strict()
function environment() {
  const value = process.env.VERCEL_ENV
  return value === 'production' || value === 'preview' ? value : 'development'
}
export function usageEnabled() {
  return process.env.IMPORT_USAGE_LOG !== '0'
}
/**
 * Best effort and idempotent for a stable `id`, so Workflow retries do not duplicate rows. Call
 * outside an open transaction: a failed insert must never abort import work. Never throws.
 */
export async function recordUsage(
  db: Client,
  value: UsageEvent,
  context: UsageContext = {},
  id: string = randomUUID()
): Promise<boolean> {
  if (!usageEnabled()) return false
  try {
    const parsed = usageEventSchema.parse(value),
      { jobId, targetRef } = contextSchema.parse(context)
    // Later events inherit the project ref recorded when the browser job was created.
    await db.query(
      safeSql`INSERT INTO public.usage_events(id,event,job_id,target_ref,environment,properties) VALUES($1,$2,$3::uuid,coalesce($4::text,(SELECT u.target_ref FROM public.usage_events u WHERE u.job_id=$3::uuid AND u.target_ref IS NOT NULL LIMIT 1)),$5,$6) ON CONFLICT(id) DO NOTHING`,
      [
        id,
        parsed.action,
        jobId ?? null,
        targetRef ?? null,
        environment(),
        JSON.stringify(parsed.properties),
      ]
    )
    return true
  } catch {
    return false
  }
}
/** For callers without a service connection. Opens and closes one; never throws. */
export async function recordUsageDetached(
  value: UsageEvent,
  context?: UsageContext,
  id?: string
): Promise<boolean> {
  if (!usageEnabled()) return false
  let db: Client | undefined
  try {
    db = await connectStore()
    return await recordUsage(db, value, context, id)
  } catch {
    return false
  } finally {
    try {
      await db?.end()
    } catch {
      /* A failed close must not surface either. */
    }
  }
}
