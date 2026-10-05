import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { PlatformRetryError, retryDeadline } from '../src/platform-retry'
import { exchangeTokens } from '../src/server/oauth-client'
import { platformFetch } from '../src/server/platform-api'
import { errorResponse } from '../src/server/session'

const now = Date.parse('2026-09-08T12:00:00Z')
const epoch = (offset: number) => String(Math.floor(now / 1000) + offset)
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  vi.spyOn(Math, 'random').mockReturnValue(0)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
it.each([
  [{ 'Retry-After': '120' }, 120000],
  [{ 'Retry-After': 'Tue, 08 Sep 2026 12:02:00 GMT' }, 120000],
  [{ 'X-RateLimit-Reset': '45' }, 45000],
  [{ 'Retry-After': '20', 'X-RateLimit-Reset': '45' }, 45000],
  [{ 'Retry-After': '0' }, 1000],
  [{ 'Retry-After': '-1' }, 60000],
  [{ 'Retry-After': 'garbage', 'X-RateLimit-Reset': '30' }, 30000],
  [{ 'Retry-After': 'Infinity' }, 60000],
  [{ 'Retry-After': 'Tue, 08 Sep 2026 11:00:00 GMT' }, 1000],
  [{ 'Retry-After': '7200' }, 7200000],
  [{ 'X-RateLimit-Reset': epoch(120) }, 120000],
  [{ 'X-RateLimit-Reset': epoch(7200) }, 7200000],
  [{ 'X-RateLimit-Reset': epoch(-60) }, 1000],
])('respects provider retry headers %j', (headers, delay) => {
  expect(retryDeadline(new Headers(headers), 429, 0, now)).toBe(now + delay)
})
it('never shortens a provider deadline when adding jitter', () => {
  vi.mocked(Math.random).mockReturnValue(0.5)
  expect(retryDeadline(new Headers({ 'Retry-After': '86400' }), 429, 0, now)).toBe(now + 86400500)
  expect(retryDeadline(new Headers({ 'X-RateLimit-Reset': epoch(60) }), 429, 0, now)).toBe(
    now + 60500
  )
})
it('uses the provider clock for HTTP dates', () => {
  expect(
    retryDeadline(
      new Headers({
        Date: 'Tue, 08 Sep 2026 11:00:00 GMT',
        'Retry-After': 'Tue, 08 Sep 2026 11:02:00 GMT',
      }),
      429,
      0,
      now
    )
  ).toBe(now + 120000)
})
it('backs off exponentially with bounded jitter when no header is available', () => {
  expect(retryDeadline(new Headers(), 429, 2, now)).toBe(now + 240000)
  expect(retryDeadline(new Headers(), 503, 2, now)).toBe(now + 8000)
  vi.mocked(Math.random).mockReturnValue(0.5)
  expect(retryDeadline(new Headers({ 'Retry-After': '60' }), 429, 0, now)).toBe(now + 60500)
})
it.each([429, 500, 502, 503, 504])('defers %i without an in-process retry loop', async (status) => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response('private-provider-data', { status, headers: { 'Retry-After': '90' } })
    )
  vi.stubGlobal('fetch', fetcher)
  await expect(platformFetch('https://api.supabase.com/v1/projects', {})).rejects.toMatchObject({
    retryAt: now + 90000,
    status,
  })
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('propagates token throttling without turning it into invalid authorization', async () => {
  vi.stubEnv('IMPORT_OAUTH_CLIENT_ID', 'test')
  vi.stubEnv('IMPORT_OAUTH_CLIENT_SECRET', 'secret')
  vi.stubEnv(
    'IMPORT_OAUTH_REDIRECT_URI',
    'http://localhost:3009/migrate/instantdb/api/supabase/callback'
  )
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(null, { status: 429, headers: { 'Retry-After': '60' } }))
  )
  await expect(
    exchangeTokens({ grant_type: 'refresh_token', refresh_token: 'secret' })
  ).rejects.toBeInstanceOf(PlatformRetryError)
})
it('returns a safe browser error and remaining retry delay', async () => {
  const response = errorResponse(new PlatformRetryError(429, now + 90500))
  expect(response.status).toBe(429)
  expect(response.headers.get('Retry-After')).toBe('91')
  expect(await response.json()).toEqual({ error: expect.any(String), retryAt: now + 90500 })
})
it.each([400, 401, 403])('leaves permanent HTTP %i errors for the caller', async (status) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status })))
  expect((await platformFetch('https://api.supabase.com/v1/projects', {})).status).toBe(status)
})
