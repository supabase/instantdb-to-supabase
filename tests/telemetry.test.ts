import type { Client } from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { POST } from '../app/api/telemetry/route'
import { captureJobProgress, eventId, telemetryId } from '../src/telemetry/server'

const id = '00000000-0000-4000-8000-000000000001'
const fetcher = vi.fn()
const request = (value: unknown, headers: Record<string, string> = {}) =>
  new Request('https://import.example/api/telemetry?secret=private', {
    method: 'POST',
    headers: { origin: 'https://import.example', ...headers },
    body: JSON.stringify(value),
  })
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
  it('sends anonymous events without request context or credentials', async () => {
    const result = await POST(
      request(event, {
        cookie: `instant-import-analytics=${id}; instant-import-session=secret`,
        referer: 'https://private.example',
        'x-forwarded-for': '1.2.3.4',
      })
    )
    expect(result.status).toBe(204)
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('https://eu.i.posthog.com/i/v0/e/')
    expect(JSON.parse(init.body)).toMatchObject({
      distinct_id: id,
      event: event.action,
      properties: {
        importAction: 'retry',
        app: 'instant-import',
        $process_person_profile: false,
        $geoip_disable: true,
      },
    })
    for (const secret of ['private.example', '1.2.3.4', 'secret', 'instant-import-session'])
      expect(init.body).not.toContain(secret)
    expect(result.headers.get('set-cookie')).toBeNull()
  })
  it('creates an independent anonymous cookie and a sanitized standard pageview', async () => {
    const result = await POST(request({ action: '$pageview', properties: {} }))
    expect(result.headers.get('set-cookie')).toMatch(
      /instant-import-analytics=.*HttpOnly; SameSite=Lax.*Secure/
    )
    expect(JSON.parse(fetcher.mock.calls[0][1].body).properties.$pathname).toBe('/')
  })
  it.each(['email', 'fileName', 'sql', 'prompt', '$current_url', 'projectRef', 'error'])(
    'rejects unexpected %s properties',
    async (field) => {
      expect(
        (
          await POST(
            request({ ...event, properties: { importAction: 'retry', [field]: 'private' } })
          )
        ).status
      ).toBe(400)
      expect(fetcher).not.toHaveBeenCalled()
    }
  )
  it.each(['something_viewed', 'instant_import_completed', 'instant_import_stage_updated'])(
    'rejects client-forged %s',
    async (action) => {
      expect((await POST(request({ action, properties: {} }))).status).toBe(400)
      expect(fetcher).not.toHaveBeenCalled()
    }
  )
  it.each(['dnt', 'sec-gpc'])('honors %s', async (header) => {
    const req = request(event, { [header]: '1', cookie: `instant-import-analytics=${id}` })
    expect(telemetryId(req)).toBeNull()
    expect((await POST(req)).headers.get('set-cookie')).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each(['', 'preview', 'development'])(
    'is disabled outside production (%s)',
    async (environment) => {
      vi.stubEnv('VERCEL_ENV', environment)
      vi.stubEnv('IMPORT_TELEMETRY_DEV', '')
      expect((await POST(request(event))).headers.get('set-cookie')).toBeNull()
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
    await POST(request(event))
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('rejects cross-origin and oversized payloads', async () => {
    expect((await POST(request(event, { origin: 'https://evil.example' }))).status).toBe(400)
    expect((await POST(request({ action: 'a'.repeat(3000) }))).status).toBe(400)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('never rejects user actions for analytics delivery failures', async () => {
    fetcher.mockRejectedValue(new Error('network error containing credentials'))
    expect((await POST(request(event))).status).toBe(204)
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
