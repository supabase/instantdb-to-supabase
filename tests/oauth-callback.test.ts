import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { encryptSecret } from '../src/server/credentials'
import { connectSupabase, supabaseCallback } from '../src/server/oauth'
import { digest } from '../src/server/session'

const store = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn(), initialize: vi.fn() }))
vi.mock('../src/workflow/store', () => ({
  connectStore: async () => ({ query: store.query, end: store.end }),
  initializeStore: store.initialize,
}))
const state = 'a'.repeat(43),
  cookie = 'b'.repeat(43),
  owner = 'owner'
const callback = (query = `state=${state}&code=authorization-code`, value = cookie) =>
  new Request(`http://localhost:3009/api/supabase/callback?${query}`, {
    headers: { cookie: `instant-import-oauth-flow=${value}` },
  })
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('IMPORT_OAUTH_CLIENT_ID', 'client')
  vi.stubEnv('IMPORT_OAUTH_CLIENT_SECRET', 'private-secret')
  vi.stubEnv('IMPORT_OAUTH_REDIRECT_URI', 'http://localhost:3009/api/supabase/callback')
  vi.stubEnv('IMPORT_CREDENTIAL_KEY', Buffer.alloc(32, 7).toString('base64'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
function pendingFlow() {
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
    expect(result.headers.get('location')).toBe('http://localhost:3009/?supabase=error')
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
    expect(result.headers.get('location')).toBe('http://localhost:3009/?supabase=connected')
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
      new Request('http://localhost:3009/api/supabase/connect', {
        method: 'POST',
        headers: { origin: 'https://other.example' },
      })
    )
    expect(response.status).toBe(403)
    expect(store.initialize).not.toHaveBeenCalled()
  })
})
