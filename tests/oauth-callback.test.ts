import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { encryptSecret } from '../src/server/credentials'
import { connectSupabase, supabaseCallback } from '../src/server/oauth'
import { digest } from '../src/server/session'

const store = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn() }))
vi.mock('../src/workflow/store', () => ({
  connectStore: async () => ({ query: store.query, end: store.end }),
}))
const state = 'a'.repeat(43),
  cookie = 'b'.repeat(43),
  owner = 'owner'
const callback = (query = `state=${state}&code=authorization-code`, value = cookie) =>
  new Request(`http://localhost:3009/migrate/instantdb/api/supabase/callback?${query}`, {
    headers: { cookie: `instant-import-oauth-flow=${value}` },
  })
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('IMPORT_OAUTH_CLIENT_ID', 'client')
  vi.stubEnv('IMPORT_OAUTH_CLIENT_SECRET', 'private-secret')
  vi.stubEnv(
    'IMPORT_OAUTH_REDIRECT_URI',
    'http://localhost:3009/migrate/instantdb/api/supabase/callback'
  )
  vi.stubEnv('IMPORT_CREDENTIAL_KEY', Buffer.alloc(32, 7).toString('base64'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
function pendingFlow(telemetryId: string | null = null) {
  let consumed = false
  store.query.mockImplementation(async (sql: string, parameters?: unknown[]) => {
    if (sql.startsWith('SELECT session_hash'))
      return {
        rows: parameters?.[1] === digest(cookie) && !consumed ? [{ session_hash: owner }] : [],
      }
    if (sql.startsWith('DELETE FROM instant_import_service.oauth_states')) {
      if (consumed) return { rows: [] }
      consumed = true
      return {
        rows: [
          {
            session_hash: owner,
            verifier: encryptSecret(`oauth-state:${digest(state)}`, 'c'.repeat(43)),
            telemetry_id: telemetryId,
          },
        ],
      }
    }
    return { rows: [] }
  })
}
describe('OAuth callback browser binding and replay protection', () => {
  it('rejects a missing or wrong browser cookie before token exchange', async () => {
    pendingFlow()
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const result = await supabaseCallback(callback(undefined, 'x'.repeat(43)))
    expect(result.headers.get('location')).toBe(
      'http://localhost:3009/migrate/instantdb?supabase=error'
    )
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('consumes the state on denial without requesting tokens', async () => {
    pendingFlow()
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const result = await supabaseCallback(
      callback(`state=${state}&error=access_denied&error_description=untrusted`)
    )
    expect(result.headers.get('location')).toContain('supabase=denied')
    expect(result.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(fetcher).not.toHaveBeenCalled()
    expect((await supabaseCallback(callback())).headers.get('location')).toContain('supabase=error')
  })
  it('encrypts tokens and accepts a valid flow only once, without requiring the Strict session cookie on the cross-site callback', async () => {
    pendingFlow()
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3600,
        token_type: 'Bearer',
      })
    )
    vi.stubGlobal('fetch', fetcher)
    const result = await supabaseCallback(callback())
    expect(result.headers.get('location')).toBe(
      'http://localhost:3009/migrate/instantdb?supabase=connected'
    )
    const insert = store.query.mock.calls.find(([sql]) =>
      sql.startsWith('INSERT INTO instant_import_service.oauth_connections')
    )!
    expect(Buffer.isBuffer(insert[1][1])).toBe(true)
    expect(insert[1][1].includes(Buffer.from('refresh'))).toBe(false)
    expect((await supabaseCallback(callback())).headers.get('location')).toContain('supabase=error')
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('rejects expired or already-consumed state', async () => {
    store.query.mockResolvedValue({ rows: [] })
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    expect((await supabaseCallback(callback())).headers.get('location')).toContain('supabase=error')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('rejects cross-origin initiation before storing OAuth state', async () => {
    const response = await connectSupabase(
      new Request('http://localhost:3009/migrate/instantdb/api/supabase/connect', {
        method: 'POST',
        headers: { origin: 'https://other.example' },
      })
    )
    expect(response.status).toBe(403)
    expect(store.query).not.toHaveBeenCalled()
  })
})
describe('analytics ID carried through the OAuth round trip', () => {
  const id = '00000000-0000-4000-8000-000000000001'
  const tokens = {
    access_token: 'access',
    refresh_token: 'refresh',
    expires_in: 3600,
    token_type: 'Bearer',
  }
  const captured = (fetcher: ReturnType<typeof vi.fn>) =>
    fetcher.mock.calls
      .filter(([url]) => String(url).startsWith('https://eu.i.posthog.com'))
      .map(([, init]) => JSON.parse(init.body))
  const connect = (body?: string, headers: Record<string, string> = {}) =>
    connectSupabase(
      new Request('http://localhost:3009/migrate/instantdb/api/supabase/connect', {
        method: 'POST',
        headers: { origin: 'http://localhost:3009', ...headers },
        body,
      })
    )
  const storedId = () =>
    store.query.mock.calls.find(([sql]) =>
      sql.startsWith('INSERT INTO instant_import_service.oauth_states')
    )![1][4]
  beforeEach(() => {
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('IMPORT_POSTHOG_KEY', 'test-project-key')
    vi.stubEnv('IMPORT_POSTHOG_HOST', 'https://eu.i.posthog.com')
  })
  it.each([
    [JSON.stringify({ telemetryId: id }), {}, id],
    [JSON.stringify({ telemetryId: 'x' }), {}, null],
    [undefined, {}, null],
    [JSON.stringify({ telemetryId: id }), { 'sec-gpc': '1' }, null],
  ])(
    'stores the connect request ID only when valid and not opted out (%s)',
    async (body, headers, expected) => {
      store.query.mockResolvedValue({ rows: [{ ready: true }] })
      const response = await connect(body, headers)
      expect(response.status).toBe(200)
      expect(storedId()).toBe(expected)
    }
  )
  it('captures the connection with the stored ID and returns it in the fragment', async () => {
    pendingFlow(id)
    const fetcher = vi.fn(async (url: string) =>
      url.startsWith('https://eu.i.posthog.com') ? new Response(null) : Response.json(tokens)
    )
    vi.stubGlobal('fetch', fetcher)
    const result = await supabaseCallback(callback())
    expect(result.headers.get('location')).toBe(
      `http://localhost:3009/migrate/instantdb?supabase=connected#telemetryId=${id}`
    )
    expect(captured(fetcher)).toMatchObject([
      { distinct_id: id, event: 'instant_import_connection_completed' },
    ])
  })
  it('keeps the ID when token exchange fails after the state is consumed', async () => {
    pendingFlow(id)
    const fetcher = vi.fn(async (url: string) => {
      if (url.startsWith('https://eu.i.posthog.com')) return new Response(null)
      throw new Error('token endpoint unavailable')
    })
    vi.stubGlobal('fetch', fetcher)
    const result = await supabaseCallback(callback())
    expect(result.headers.get('location')).toBe(
      `http://localhost:3009/migrate/instantdb?supabase=error#telemetryId=${id}`
    )
    expect(captured(fetcher)).toMatchObject([
      {
        distinct_id: id,
        event: 'instant_import_connection_failed',
        properties: { connectionResult: 'error' },
      },
    ])
  })
  it('drops the stored ID when the callback request carries a privacy signal', async () => {
    pendingFlow(id)
    const fetcher = vi.fn(async (url: string) =>
      url.startsWith('https://eu.i.posthog.com') ? new Response(null) : Response.json(tokens)
    )
    vi.stubGlobal('fetch', fetcher)
    const request = callback()
    request.headers.set('sec-gpc', '1')
    const result = await supabaseCallback(request)
    expect(result.headers.get('location')).toBe(
      'http://localhost:3009/migrate/instantdb?supabase=connected'
    )
    expect(captured(fetcher)).toEqual([])
  })
})
