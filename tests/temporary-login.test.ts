import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { decryptSecret, encryptSecret } from '../src/server/credentials'
import { resolveOAuthTarget } from '../src/server/oauth'
import { temporaryConnection } from '../src/server/temporary-login'

const store = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn() }))
vi.mock('../src/workflow/store', () => ({ connectStore: async () => store }))
const ref = 'abcdefghijklmnopqrst'
const pool = [
  {
    database_type: 'PRIMARY',
    connection_string: `postgresql://postgres.${ref}:[YOUR-PASSWORD]@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres`,
  },
]
const login = { role: 'cli_login_postgres', password: 'a:@/?%# b', ttl_seconds: 300 }
const tokens = {
  access_token: 'access',
  refresh_token: 'refresh',
  token_type: 'Bearer',
  expires_in: 3600,
}
let connected: boolean, cached: { credential: Buffer; expires_at: Date } | undefined, expires: Date
let requests: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('IMPORT_OAUTH_CLIENT_ID', 'client')
  vi.stubEnv('IMPORT_OAUTH_CLIENT_SECRET', 'secret')
  vi.stubEnv('IMPORT_OAUTH_REDIRECT_URI', 'http://localhost:3009/api/supabase/callback')
  vi.stubEnv('IMPORT_CREDENTIAL_KEY', Buffer.alloc(32, 9).toString('base64'))
  connected = true
  cached = undefined
  expires = new Date(Date.now() + 3600000)
  store.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('SELECT 1 FROM instant_import_service.oauth_connections'))
      return { rowCount: connected ? 1 : 0 }
    if (sql.startsWith('SELECT * FROM instant_import_service.oauth_connections'))
      return {
        rows: connected
          ? [{ tokens: encryptSecret('oauth-tokens:owner', tokens), expires_at: expires }]
          : [],
      }
    if (sql.startsWith('SELECT credential')) return { rows: cached ? [cached] : [] }
    if (sql.startsWith('INSERT INTO instant_import_service.oauth_database_credentials'))
      cached = { credential: params[2] as Buffer, expires_at: params[3] as Date }
    return { rows: [] }
  })
  requests = vi.fn(async (url: string) => {
    if (url.endsWith('/projects'))
      return Response.json([{ id: ref, name: 'test', region: 'region', status: 'ACTIVE_HEALTHY' }])
    if (url.endsWith('/pooler')) return Response.json(pool)
    if (url.includes('/api-keys'))
      return Response.json([{ name: 'service_role', api_key: 'private-key' }])
    if (url.endsWith('/cli/login-role')) return Response.json(login)
    if (url.endsWith('/oauth/token')) return Response.json({ ...tokens, access_token: 'renewed' })
    throw Error('Unexpected request')
  })
  vi.stubGlobal('fetch', requests)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('temporary database connection routing', () => {
  it('uses the primary session pooler, escaped credentials, TLS, and postgres role', () => {
    const target = temporaryConnection(ref, pool, login, 'key'),
      url = new URL(target.databaseUrl)
    expect(url.port).toBe('5432')
    expect(url.search).toBe('?sslmode=verify-full')
    expect(decodeURIComponent(url.username)).toBe(`cli_login_postgres.${ref}`)
    expect(decodeURIComponent(url.password)).toBe(login.password)
    expect(target.databaseRole).toBe('postgres')
    expect(target.supabaseUrl).toBe(`https://${ref}.supabase.co`)
  })
  it.each([
    `postgresql://postgres.${ref}:pw@evil.example:5432/postgres`,
    `postgresql://postgres.other:pw@aws-0-region.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres.${ref}:pw@aws-0-region.pooler.supabase.com:5432/postgres?host=evil.example`,
    `postgresql://postgres.${ref}:pw@aws-0-region.pooler.supabase.com:6543/other`,
    `http://postgres.${ref}:pw@aws-0-region.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres.${ref}:pw@aws-0-region.pooler.supabase.com.evil.example:5432/postgres`,
  ])('rejects untrusted routing %s', (connection_string) => {
    expect(() =>
      temporaryConnection(ref, [{ database_type: 'PRIMARY', connection_string }], login, 'key')
    ).toThrow()
  })
  it('never selects a read replica', () => {
    expect(() =>
      temporaryConnection(ref, [{ ...pool[0], database_type: 'READ_REPLICA' }], login, 'key')
    ).toThrow()
  })
  it.each([
    { ...login, ttl_seconds: 1 },
    { ...login, role: 'postgres;select 1' },
    { ...login, password: '' },
  ])('rejects malformed credentials', (value) => {
    expect(() => temporaryConnection(ref, pool, value, 'key')).toThrow()
  })
})

describe('OAuth database credential lifecycle', () => {
  it('authorizes the project before minting and persists encrypted credentials', async () => {
    const target = await resolveOAuthTarget('owner', ref)
    expect(requests.mock.calls.map((c) => c[0])).toEqual([
      'https://api.supabase.com/v1/projects',
      `https://api.supabase.com/v1/projects/${ref}/config/database/pooler`,
      `https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`,
      `https://api.supabase.com/v1/projects/${ref}/cli/login-role`,
    ])
    const init = (requests.mock.calls.at(-1) as unknown as [string, RequestInit])[1]
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ read_only: false })
    expect(cached!.credential.includes(Buffer.from(login.password))).toBe(false)
    expect(decryptSecret(`oauth-database:owner:${ref}`, cached!.credential)).toEqual(target)
    expect(() => decryptSecret(`oauth-database:other:${ref}`, cached!.credential)).toThrow()
  })
  it('reuses a valid lease without making an API request for each batch', async () => {
    const first = await resolveOAuthTarget('owner', ref)
    requests.mockClear()
    expect(await resolveOAuthTarget('owner', ref)).toEqual(first)
    expect(requests).not.toHaveBeenCalled()
  })
  it('renews before expiry after a worker restart', async () => {
    await resolveOAuthTarget('owner', ref)
    cached!.expires_at = new Date(Date.now() + 10000)
    requests.mockClear()
    await resolveOAuthTarget('owner', ref)
    expect(requests.mock.calls.some((c) => c[0].endsWith('/cli/login-role'))).toBe(true)
  })
  it('can renew after another CLI client invalidates an unexpired password', async () => {
    await resolveOAuthTarget('owner', ref)
    requests.mockClear()
    await resolveOAuthTarget('owner', ref, true)
    expect(requests.mock.calls.some((c) => c[0].endsWith('/cli/login-role'))).toBe(true)
  })
  it('refuses cached credentials after disconnect', async () => {
    await resolveOAuthTarget('owner', ref)
    connected = false
    requests.mockClear()
    await expect(resolveOAuthTarget('owner', ref)).rejects.toThrow('Reconnect Supabase')
    expect(requests).not.toHaveBeenCalled()
  })
  it.each(['unauthorized', 'paused'])('does not mint for a %s project', async (condition) => {
    requests.mockResolvedValueOnce(
      Response.json([
        {
          id: condition === 'unauthorized' ? 'z'.repeat(20) : ref,
          name: 'test',
          region: 'region',
          status: condition === 'paused' ? 'INACTIVE' : 'ACTIVE_HEALTHY',
        },
      ])
    )
    await expect(resolveOAuthTarget('owner', ref)).rejects.toThrow()
    expect(requests).toHaveBeenCalledTimes(1)
    expect(cached).toBeUndefined()
  })
  it('refreshes an expired OAuth token before minting a database login', async () => {
    expires = new Date(0)
    await resolveOAuthTarget('owner', ref)
    expect(requests.mock.calls[0][0]).toContain('/oauth/token')
    expect(
      store.query.mock.calls.some((c) =>
        String(c[0]).startsWith('INSERT INTO instant_import_service.oauth_connections')
      )
    ).toBe(true)
  })
  it('refreshes once on a rejected access token', async () => {
    requests.mockResolvedValueOnce(new Response('', { status: 401 }))
    await resolveOAuthTarget('owner', ref)
    expect(requests.mock.calls.filter((c) => c[0].endsWith('/oauth/token'))).toHaveLength(1)
  })
  it.each([403, 429, 500])(
    'does not cache failures or expose provider bodies (%s)',
    async (status) => {
      requests.mockResolvedValueOnce(new Response('private-provider-detail', { status }))
      await expect(resolveOAuthTarget('owner', ref)).rejects.not.toThrow('private-provider-detail')
      expect(cached).toBeUndefined()
    }
  )
})
