import { createHash, randomUUID } from 'node:crypto'
import { safeSql } from '@supabase/pg-meta'
import type { Client } from 'pg'
import { z } from 'zod'

import { decryptTarget } from '../server/credentials'
import { progressStageSchema, type EventMap } from './contracts'
import type { InstantImportProgressEvent } from './events'
import { completionStatsSchema, recordUsage, usageEnabled } from './usage'

export function telemetryConfig() {
  const key = process.env.IMPORT_POSTHOG_KEY
  const host = process.env.IMPORT_POSTHOG_HOST
  if (
    !key ||
    !host ||
    (process.env.VERCEL_ENV !== 'production' && process.env.IMPORT_TELEMETRY_DEV !== '1')
  )
    return null
  try {
    const url = new URL(host)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      return null
    return { key, endpoint: `${url.href.replace(/\/$/, '')}/i/v0/e/` }
  } catch {
    return null
  }
}
export function requestTelemetryId(request: Request, body: unknown) {
  if (
    !telemetryConfig() ||
    request.headers.get('dnt') === '1' ||
    request.headers.get('sec-gpc') === '1'
  )
    return null
  const value = z.object({ telemetryId: z.string().uuid() }).safeParse(body)
  return value.success ? value.data.telemetryId : null
}
/** Stable event IDs let PostHog deduplicate retries without emitting source data. */
export function eventId(key: string) {
  const bytes = createHash('sha256').update(key).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 15) | 0x50
  bytes[8] = (bytes[8] & 63) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
/** Best effort, bounded delivery. Analytics failures must never fail an import. */
export async function capture<A extends keyof EventMap>(
  distinctId: string | null,
  action: A,
  properties: EventMap[A],
  uuid: string = randomUUID()
): Promise<boolean> {
  const config = telemetryConfig()
  if (!config || !distinctId) return false
  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(1500),
      redirect: 'error',
      body: JSON.stringify({
        api_key: config.key,
        event: action,
        distinct_id: distinctId,
        uuid,
        properties: {
          ...properties,
          app: 'instant-import',
          source: 'instant-import',
          $process_person_profile: false,
          $geoip_disable: true,
        },
      }),
    })
    await response.body?.cancel()
    if (!response.ok) console.warn('Import telemetry delivery failed', response.status)
    return response.ok
  } catch {
    return false
  }
}
function destinationRef(jobId: string, encrypted: Buffer) {
  try {
    const target = decryptTarget(jobId, encrypted)
    return 'projectRef' in target ? target.projectRef : undefined
  } catch {
    return undefined
  }
}
/** Called from committed worker transitions, not from browser polling. */
export async function captureJobProgress(db: Client, jobId: string, phase: string, failed = false) {
  if (!progressStageSchema.safeParse(phase).success || (!usageEnabled() && !telemetryConfig()))
    return
  try {
    // CLI jobs have no browser row: they reach the usage log but never PostHog.
    const row = (
      await db.query(
        safeSql`SELECT b.telemetry_id,b.target_encrypted,j.error_code,extract(epoch FROM (now()-coalesce(b.created_at,j.created_at)))*1000 AS elapsed_ms FROM instant_import_service.jobs j LEFT JOIN instant_import_service.browser_jobs b ON b.job_id=j.id WHERE j.id=$1`,
        [jobId]
      )
    ).rows[0]
    if (!row) return
    const projectRef = row.telemetry_id ? destinationRef(jobId, row.target_encrypted) : undefined
    if (phase === 'analyzing' && !failed) {
      const uploadId = eventId(`${jobId}:upload`)
      const stats = await uploadStats(db, jobId)
      if (stats)
        await recordUsage(
          db,
          { action: 'instant_import_upload_completed', properties: stats },
          { jobId },
          uploadId
        )
      await capture(
        row.telemetry_id ?? null,
        'instant_import_upload_completed',
        { importAction: 'upload' },
        uploadId
      )
    }
    const action: InstantImportProgressEvent['action'] =
      failed || phase === 'blocked'
        ? 'instant_import_failed'
        : phase === 'completed'
          ? 'instant_import_completed'
          : phase === 'cancelled'
            ? 'instant_import_closed'
            : 'instant_import_stage_updated'
    const importStage = phase as InstantImportProgressEvent['properties']['importStage'],
      elapsedMs = Math.max(0, Math.round(Number(row.elapsed_ms) || 0)),
      id = eventId(`${jobId}:${action}:${phase}`),
      // A fixed code set by this pipeline, never a driver or step message.
      errorCode =
        failed && ['STEP_FAILED', 'RUN_FAILED'].includes(row.error_code)
          ? row.error_code
          : undefined
    await recordUsage(
      db,
      action === 'instant_import_completed'
        ? {
            action,
            properties: { importStage, elapsedMs, stats: await completionStats(db, jobId) },
          }
        : { action, properties: { importStage, elapsedMs, ...(errorCode ? { errorCode } : {}) } },
      { jobId },
      id
    )
    await capture(
      row.telemetry_id ?? null,
      action,
      { jobId, ...(projectRef && { projectRef }), importStage, elapsedMs },
      id
    )
  } catch {
    /* Older jobs and analytics outages must not affect migration work. */
  }
}
async function uploadStats(db: Client, jobId: string) {
  if (!usageEnabled()) return undefined
  try {
    const row = (
      await db.query(
        safeSql`SELECT count(*) AS files,coalesce(sum(size),0) AS bytes,count(*) FILTER(WHERE kind='entity') AS entities,count(*) FILTER(WHERE kind='blob') AS blobs FROM instant_import_service.files WHERE job_id=$1`,
        [jobId]
      )
    ).rows[0]
    return {
      fileCount: Number(row?.files ?? 0),
      totalBytes: Number(row?.bytes ?? 0),
      entityFiles: Number(row?.entities ?? 0),
      blobFiles: Number(row?.blobs ?? 0),
    }
  } catch {
    return undefined
  }
}
/** Aggregate totals from the retained verification report; omitted if it is unavailable. */
async function completionStats(db: Client, jobId: string) {
  if (!usageEnabled()) return undefined
  try {
    const row = (
      await db.query(
        safeSql`SELECT v->'verified' AS verified,v->'sourceTotals' AS source,v->'permissions' AS permissions FROM (SELECT convert_from(bytes,'UTF8')::jsonb AS v FROM instant_import_service.artifacts WHERE job_id=$1 AND name='verification.json') a`,
        [jobId]
      )
    ).rows[0]
    const stats = completionStatsSchema.safeParse(row)
    return stats.success ? stats.data : undefined
  } catch {
    return undefined
  }
}
