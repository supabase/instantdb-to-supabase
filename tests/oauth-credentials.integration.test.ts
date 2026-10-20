import { randomUUID } from 'node:crypto'
import { safeSql } from '@supabase/pg-meta'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { PlatformRetryError } from '../src/platform-retry'
import { decryptSecret, encryptSecret } from '../src/server/credentials'
import { resolveOAuthTarget } from '../src/server/oauth'
import { platformFetch, platformScope } from '../src/server/platform-api'
import { ensureStore } from '../src/server/store-ready'
import { connectStore } from '../src/workflow/store'

const url = process.env.IMPORT_JOB_DATABASE_URL
if (url && !['localhost', '127.0.0.1'].includes(new URL(url).hostname))
  throw Error('OAuth integration tests require a local service database')
describe.skipIf(!url)('durable OAuth credential leases', () => {
  let db: Awaited<ReturnType<typeof connectStore>>, owner: string, calls: ReturnType<typeof vi.fn>
  const ref = 'a'.repeat(20)
  beforeAll(async () => {
    db = await connectStore()
    await ensureStore(db)
  })
  afterAll(async () => {
    await db?.end()
  })
  beforeEach(async () => {
    owner = `oauth-test-${randomUUID()}`
    vi.stubEnv('IMPORT_CREDENTIAL_KEY', Buffer.alloc(32, 8).toString('base64'))
    vi.stubEnv('IMPORT_OAUTH_CLIENT_ID', owner)
    vi.stubEnv('IMPORT_OAUTH_CLIENT_SECRET', 'test')
    vi.stubEnv(
      'IMPORT_OAUTH_REDIRECT_URI',
      'http://localhost:3009/migrate/instantdb/api/supabase/callback'
    )
    await db.query(
      safeSql`INSERT INTO instant_import_service.oauth_connections(session_hash,tokens,expires_at) VALUES($1,$2,$3)`,
      [
        owner,
        encryptSecret(`oauth-tokens:${owner}`, {
          access_token: 'old',
          refresh_token: 'refresh-old',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
        new Date(0),
      ]
    )
    calls = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/oauth/token')) {
        expect(['refresh-old', 'refresh-new']).toContain(
          new URLSearchParams(init.body as URLSearchParams).get('refresh_token')
        )
        return Response.json({
          access_token: 'new',
          refresh_token: 'refresh-new',
          token_type: 'Bearer',
          expires_in: 3600,
        })
      }
      if (url.endsWith('/projects'))
        return Response.json([{ id: ref, name: 'test', status: 'ACTIVE_HEALTHY', region: 'test' }])
      if (url.endsWith('/pooler'))
        return Response.json([
          {
            database_type: 'PRIMARY',
            connection_string: `postgresql://postgres.${ref}:pw@aws-0-region.pooler.supabase.com:6543/postgres`,
          },
        ])
      if (url.includes('/api-keys'))
        return Response.json([{ name: 'service_role', api_key: 'test-key' }])
      if (url.endsWith('/cli/login-role'))
        return Response.json({
          role: 'cli_login_postgres',
          password: randomUUID(),
          ttl_seconds: 300,
        })
      throw Error('Unexpected endpoint')
    })
    vi.stubGlobal('fetch', calls)
  })
  afterEach(async () => {
    await db.query(
      safeSql`DELETE FROM instant_import_service.oauth_connections WHERE session_hash=$1`,
      [owner]
    )
    await db.query(safeSql`DELETE FROM instant_import_service.platform_cooldowns WHERE scope=$1`, [
      platformScope('https://api.supabase.com/v1/oauth/token'),
    ])
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })
  it('serializes concurrent token refresh and login minting across workers', async () => {
    const targets = await Promise.all(
      Array.from({ length: 5 }, () => resolveOAuthTarget(owner, ref))
    )
    expect(new Set(targets.map((t) => t.databaseUrl)).size).toBe(1)
    expect(calls.mock.calls.filter((c) => c[0].endsWith('/oauth/token'))).toHaveLength(1)
    expect(calls.mock.calls.filter((c) => c[0].endsWith('/cli/login-role'))).toHaveLength(1)
    const saved = (
      await db.query(
        safeSql`SELECT tokens FROM instant_import_service.oauth_connections WHERE session_hash=$1`,
        [owner]
      )
    ).rows[0]
    expect(decryptSecret(`oauth-tokens:${owner}`, saved.tokens)).toMatchObject({
      refresh_token: 'refresh-new',
    })
  })
  it('renews an expired lease and persists it outside the worker checkpoint transaction', async () => {
    const first = await resolveOAuthTarget(owner, ref)
    await db.query(
      safeSql`UPDATE instant_import_service.oauth_database_credentials SET expires_at=now() WHERE session_hash=$1`,
      [owner]
    )
    await db.query(safeSql`BEGIN`)
    const second = await resolveOAuthTarget(owner, ref)
    await db.query(safeSql`ROLLBACK`)
    expect(second.databaseUrl).not.toBe(first.databaseUrl)
    calls.mockClear()
    expect(await resolveOAuthTarget(owner, ref)).toEqual(second)
    expect(calls).not.toHaveBeenCalled()
  })
  it('renews both OAuth and database credentials after retries outlast both expiries', async () => {
    const first = await resolveOAuthTarget(owner, ref)
    await db.query(
      safeSql`UPDATE instant_import_service.oauth_connections SET expires_at=now()-interval '1 hour' WHERE session_hash=$1`,
      [owner]
    )
    await db.query(
      safeSql`UPDATE instant_import_service.oauth_database_credentials SET expires_at=now()-interval '10 minutes' WHERE session_hash=$1`,
      [owner]
    )
    calls.mockClear()
    const retried = await resolveOAuthTarget(owner, ref)
    expect(retried.databaseUrl).not.toBe(first.databaseUrl)
    expect(retried.databaseExpiresAt).toBeGreaterThan(Date.now() + 15000)
    expect(calls.mock.calls.filter((c) => c[0].endsWith('/oauth/token'))).toHaveLength(1)
    expect(calls.mock.calls.filter((c) => c[0].endsWith('/cli/login-role'))).toHaveLength(1)
  })
  it('keeps the OAuth connection on token throttling and refreshes after the cooldown', async () => {
    const normal = calls.getMockImplementation()!
    calls.mockImplementationOnce(
      async () => new Response(null, { status: 429, headers: { 'Retry-After': '120' } })
    )
    await expect(resolveOAuthTarget(owner, ref)).rejects.toBeInstanceOf(PlatformRetryError)
    await expect(resolveOAuthTarget(owner, ref)).rejects.toBeInstanceOf(PlatformRetryError)
    expect(calls).toHaveBeenCalledTimes(1)
    expect(
      (
        await db.query(
          safeSql`SELECT 1 FROM instant_import_service.oauth_connections WHERE session_hash=$1`,
          [owner]
        )
      ).rowCount
    ).toBe(1)
    await db.query(
      safeSql`UPDATE instant_import_service.platform_cooldowns SET retry_at=now()-interval '1 second' WHERE scope=$1`,
      [platformScope('https://api.supabase.com/v1/oauth/token')]
    )
    calls.mockImplementation(normal)
    expect((await resolveOAuthTarget(owner, ref)).databaseExpiresAt).toBeGreaterThan(Date.now())
  })
  it('keeps importing with a valid cached lease during a Management API cooldown', async () => {
    const target = await resolveOAuthTarget(owner, ref)
    calls.mockResolvedValueOnce(
      new Response(null, { status: 429, headers: { 'Retry-After': '120' } })
    )
    await expect(
      platformFetch(`https://api.supabase.com/v1/projects/${ref}/api-keys`, {}, db)
    ).rejects.toBeInstanceOf(PlatformRetryError)
    calls.mockClear()
    expect(await resolveOAuthTarget(owner, ref)).toEqual(target)
    expect(calls).not.toHaveBeenCalled()
    await db.query(safeSql`DELETE FROM instant_import_service.platform_cooldowns WHERE scope=$1`, [
      platformScope(`https://api.supabase.com/v1/projects/${ref}/api-keys`),
    ])
  })
  it('removes the cached credentials when the OAuth connection is deleted', async () => {
    await resolveOAuthTarget(owner, ref)
    await db.query(
      safeSql`DELETE FROM instant_import_service.oauth_connections WHERE session_hash=$1`,
      [owner]
    )
    expect(
      (
        await db.query(
          safeSql`SELECT 1 FROM instant_import_service.oauth_database_credentials WHERE session_hash=$1`,
          [owner]
        )
      ).rowCount
    ).toBe(0)
    await expect(resolveOAuthTarget(owner, ref)).rejects.toThrow('Reconnect Supabase')
  })
})

describe.skipIf(!url)('shared Management API cooldowns', () => {
  let db: Awaited<ReturnType<typeof connectStore>>
  let clientId: string
  beforeAll(async () => {
    db = await connectStore()
    await ensureStore(db)
  })
  afterAll(async () => {
    await db?.end()
  })
  beforeEach(() => {
    clientId = randomUUID()
    vi.stubEnv('IMPORT_OAUTH_CLIENT_ID', clientId)
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })
  afterEach(async () => {
    for (const path of [
      '/projects',
      '/projects/aaaaaaaaaaaaaaaaaaaa/config/database/pooler',
      '/projects/bbbbbbbbbbbbbbbbbbbb/api-keys',
      '/oauth/token',
    ]) {
      await db.query(
        safeSql`DELETE FROM instant_import_service.platform_cooldowns WHERE scope=$1`,
        [platformScope(`https://api.supabase.com/v1${path}`)]
      )
    }
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })
  const endpoint = 'https://api.supabase.com/v1/projects'
  async function request(path = endpoint) {
    const connection = await connectStore()
    try {
      return await platformFetch(path, {}, connection)
    } finally {
      await connection.end()
    }
  }
  it('shares a durable cooldown across workers and releases their connections', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 429, headers: { 'Retry-After': '120' } }))
    vi.stubGlobal('fetch', fetcher)
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => request()))
    expect(
      results.every(
        (result) => result.status === 'rejected' && result.reason instanceof PlatformRetryError
      )
    ).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const deadlines = results.map((result) => result.status === 'rejected' && result.reason.retryAt)
    expect(new Set(deadlines).size).toBe(1)
    await expect(request()).rejects.toBeInstanceOf(PlatformRetryError)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await db.query(
      safeSql`UPDATE instant_import_service.platform_cooldowns SET retry_at=now()-interval '1 second' WHERE scope=$1`,
      [platformScope(endpoint)]
    )
    fetcher.mockResolvedValue(Response.json({ ok: true }))
    expect((await request()).ok).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('shares project limits across endpoints without blocking another project', async () => {
    const a = 'https://api.supabase.com/v1/projects/aaaaaaaaaaaaaaaaaaaa/'
    const b = 'https://api.supabase.com/v1/projects/bbbbbbbbbbbbbbbbbbbb/'
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '60' } }))
      .mockResolvedValue(Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetcher)
    await expect(request(`${a}config/database/pooler`)).rejects.toBeInstanceOf(PlatformRetryError)
    await expect(request(`${a}api-keys`)).rejects.toBeInstanceOf(PlatformRetryError)
    expect((await request(`${b}api-keys`)).ok).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('honors a successful final request but delays the next one when the quota reaches zero', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { ok: true },
          { headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '45' } }
        )
      )
    vi.stubGlobal('fetch', fetcher)
    expect((await request()).ok).toBe(true)
    await expect(request()).rejects.toBeInstanceOf(PlatformRetryError)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('increases fallback backoff across attempts, then clears it after success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(new Response(null, { status: 429 })))
    )
    const first = await request().catch((error) => error)
    await db.query(
      safeSql`UPDATE instant_import_service.platform_cooldowns SET retry_at=now()-interval '1 second' WHERE scope=$1`,
      [platformScope(endpoint)]
    )
    const second = await request().catch((error) => error)
    expect(second.retryAt - first.retryAt).toBeGreaterThanOrEqual(60000)
  })
})
