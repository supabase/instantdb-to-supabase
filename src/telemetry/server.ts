import { createHash, randomUUID } from 'node:crypto'
import { safeSql } from '@supabase/pg-meta'
import type { Client } from 'pg'
import { z } from 'zod'

import { progressStageSchema, type BrowserEvent, type EventMap } from './contracts'
import type { InstantImportProgressEvent } from './events'

const cookieName = 'instant-import-analytics'
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
export function telemetryId(request: Request) {
  if (
    !telemetryConfig() ||
    request.headers.get('dnt') === '1' ||
    request.headers.get('sec-gpc') === '1'
  )
    return null
  const value = request.headers
    .get('cookie')
    ?.split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1)
  return z.string().uuid().safeParse(value).success ? value! : null
}
export function analyticsCookie(id: string, request: Request) {
  return `${cookieName}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${new URL(request.url).protocol === 'https:' || process.env.VERCEL_ENV === 'production' ? '; Secure' : ''}`
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
export async function capture<A extends keyof EventMap | '$pageview'>(
  distinctId: string | null,
  action: A,
  properties: A extends keyof EventMap ? EventMap[A] : Record<string, never>,
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
          ...(action === '$pageview' ? { $pathname: '/' } : {}),
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
export async function captureBrowserEvent(request: Request, value: BrowserEvent) {
  if (
    !telemetryConfig() ||
    request.headers.get('dnt') === '1' ||
    request.headers.get('sec-gpc') === '1'
  )
    return new Response(null, { status: 204 })
  const existing = telemetryId(request),
    id = existing ?? randomUUID()
  await capture(id, value.action, value.properties)
  return new Response(null, {
    status: 204,
    headers: existing ? {} : { 'Set-Cookie': analyticsCookie(id, request) },
  })
}
/** Called from committed worker transitions, not from browser polling. */
export async function captureJobProgress(db: Client, jobId: string, phase: string, failed = false) {
  if (!telemetryConfig() || !progressStageSchema.safeParse(phase).success) return
  try {
    const row = (
      await db.query(
        safeSql`SELECT telemetry_id,extract(epoch FROM (now()-created_at))*1000 AS elapsed_ms FROM instant_import_service.browser_jobs WHERE job_id=$1`,
        [jobId]
      )
    ).rows[0]
    if (!row?.telemetry_id) return
    if (phase === 'analyzing' && !failed)
      await capture(
        row.telemetry_id,
        'instant_import_upload_completed',
        { importAction: 'upload' },
        eventId(`${jobId}:upload`)
      )
    const action: InstantImportProgressEvent['action'] =
      failed || phase === 'blocked'
        ? 'instant_import_failed'
        : phase === 'completed'
          ? 'instant_import_completed'
          : phase === 'cancelled'
            ? 'instant_import_closed'
            : 'instant_import_stage_updated'
    await capture(
      row.telemetry_id,
      action,
      {
        jobId,
        importStage: phase as InstantImportProgressEvent['properties']['importStage'],
        elapsedMs: Math.max(0, Math.round(Number(row.elapsed_ms) || 0)),
      },
      eventId(`${jobId}:${action}:${phase}`)
    )
  } catch {
    /* Older jobs and analytics outages must not affect migration work. */
  }
}
