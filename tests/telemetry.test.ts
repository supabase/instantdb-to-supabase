import type { Client } from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { browserEventSchema } from '../src/telemetry/contracts'
import { capture, captureJobProgress, eventId, requestTelemetryId } from '../src/telemetry/server'

const id = '00000000-0000-4000-8000-000000000001'
const fetcher = vi.fn()
const request = (headers: Record<string, string> = {}) =>
  new Request('https://import.example/api/supabase/connect', { method: 'POST', headers })
const event = { action: 'instant_import_control_clicked', properties: { importAction: 'retry' } }
beforeEach(() => {
  vi.stubEnv('VERCEL_ENV', 'production')
  vi.stubEnv('IMPORT_POSTHOG_KEY', 'test-project-key')
  vi.stubEnv('IMPORT_POSTHOG_HOST', 'https://eu.i.posthog.com')
  vi.stubGlobal(
    'fetch',
    fetcher.mockReset().mockImplementation(async () => new Response(null, { status: 200 }))
  )
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
describe('import telemetry boundary', () => {
  it('sends anonymous server events without person profiles or GeoIP', async () => {
    expect(
      await capture(id, 'instant_import_connection_completed', { connectionResult: 'connected' })
    ).toBe(true)
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('https://eu.i.posthog.com/i/v0/e/')
    expect(JSON.parse(init.body)).toMatchObject({
      distinct_id: id,
      event: 'instant_import_connection_completed',
      properties: {
        connectionResult: 'connected',
        app: 'instant-import',
        $process_person_profile: false,
        $geoip_disable: true,
      },
    })
  })
  it('accepts a carried browser ID only as a UUID', () => {
    expect(requestTelemetryId(request(), { telemetryId: id })).toBe(id)
    const posthogId = '01a15b09-4124-714f-9c78-be4057437a10'
    expect(requestTelemetryId(request(), { telemetryId: posthogId })).toBe(posthogId)
    for (const body of [null, {}, { telemetryId: 'x' }, { telemetryId: 42 }])
      expect(requestTelemetryId(request(), body)).toBeNull()
  })
  it.each(['dnt', 'sec-gpc'])('honors %s', (header) => {
    expect(requestTelemetryId(request({ [header]: '1' }), { telemetryId: id })).toBeNull()
  })
  it.each(['email', 'fileName', 'sql', 'prompt', '$current_url', 'projectRef', 'error'])(
    'rejects unexpected %s properties passed to track',
    (field) => {
      expect(
        browserEventSchema.safeParse({
          ...event,
          properties: { importAction: 'retry', [field]: 'private' },
        }).success
      ).toBe(false)
    }
  )
  it.each(['something_viewed', 'instant_import_completed', 'instant_import_stage_updated'])(
    'rejects browser-forged %s',
    (action) => {
      expect(browserEventSchema.safeParse({ action, properties: {} }).success).toBe(false)
    }
  )
  it.each(['', 'preview', 'development'])(
    'is disabled outside production (%s)',
    async (environment) => {
      vi.stubEnv('VERCEL_ENV', environment)
      vi.stubEnv('IMPORT_TELEMETRY_DEV', '')
      expect(requestTelemetryId(request(), { telemetryId: id })).toBeNull()
      expect(await capture(id, 'instant_import_control_clicked', { importAction: 'retry' })).toBe(
        false
      )
      expect(fetcher).not.toHaveBeenCalled()
    }
  )
  it.each([
    '',
    'http://insecure.example',
    'https://user:password@example.com',
    'https://example.com?token=secret',
  ])('fails closed for missing or invalid hosts (%s)', async (host) => {
    vi.stubEnv('IMPORT_POSTHOG_HOST', host)
    await capture(id, 'instant_import_control_clicked', { importAction: 'retry' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('never throws on analytics delivery failures', async () => {
    fetcher.mockRejectedValue(new Error('network error containing credentials'))
    expect(await capture(id, 'instant_import_control_clicked', { importAction: 'retry' })).toBe(
      false
    )
  })
})
describe('background import funnel', () => {
  it('captures stages and terminal outcomes with stable retry IDs', async () => {
    const query = vi
      .fn()
      .mockResolvedValue({ rows: [{ telemetry_id: id, elapsed_ms: 1200, secret: 'private' }] })
    for (const phase of ['rows', 'completed', 'blocked', 'cancelled'])
      await captureJobProgress({ query } as unknown as Client, id, phase)
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(init.body).event)).toEqual([
      'instant_import_stage_updated',
      'instant_import_completed',
      'instant_import_failed',
      'instant_import_closed',
    ])
    await captureJobProgress({ query } as unknown as Client, id, 'completed')
    expect(JSON.parse(fetcher.mock.calls[1][1].body).uuid).toBe(
      JSON.parse(fetcher.mock.calls[4][1].body).uuid
    )
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('private')
    expect(eventId('one')).not.toBe(eventId('two'))
  })
  it('skips jobs without identity and isolates database errors', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{}] })
    await captureJobProgress({ query } as unknown as Client, id, 'rows')
    query.mockRejectedValue(new Error('private connection'))
    await expect(
      captureJobProgress({ query } as unknown as Client, id, 'rows')
    ).resolves.toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
