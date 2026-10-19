import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { decryptSecret, encryptSecret } from '../src/server/credentials'
import { oauthTargetSchema } from '../src/server/oauth'
import {
  buildAuthorization,
  exchangeTokens,
  oauthConfig,
  parseProjectList,
  selectSecretKey,
} from '../src/server/oauth-client'
import { HttpError } from '../src/server/session'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
const configure = () => {
  vi.stubEnv('IMPORT_OAUTH_CLIENT_ID', 'client-id')
  vi.stubEnv('IMPORT_OAUTH_CLIENT_SECRET', 'client-secret')
  vi.stubEnv(
    'IMPORT_OAUTH_REDIRECT_URI',
    'http://localhost:3009/migrate/instantdb/api/supabase/callback'
  )
}
describe('Supabase platform OAuth', () => {
  it('uses S256 PKCE, random state, and an exact configured callback', () => {
    configure()
    const flow = buildAuthorization()
    const url = new URL(flow.url)
    expect(url.origin + url.pathname).toBe('https://api.supabase.com/v1/oauth/authorize')
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(flow.verifier).digest('base64url')
    )
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toBe(oauthConfig().redirectUri)
    expect(url.searchParams.has('scope')).toBe(false)
    expect(url.searchParams.has('client_secret')).toBe(false)
    expect(flow.state).not.toBe(buildAuthorization().state)
  })
  it.each([
    'http://example.com/migrate/instantdb/api/supabase/callback',
    'http://127.0.0.1:3009/migrate/instantdb/api/supabase/callback',
    'https://example.com/wrong-path',
    'https://example.com/api/supabase/callback',
    'https://example.com/migrate/instantdb/api/supabase/callback?next=https://evil.example',
  ])('rejects an unsafe callback %s', (uri) => {
    configure()
    vi.stubEnv('IMPORT_OAUTH_REDIRECT_URI', uri)
    expect(() => oauthConfig()).toThrow()
  })
  it('exchanges a code with Basic authentication and the stored verifier', async () => {
    configure()
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        access_token: 'access',
        refresh_token: 'refresh',
        token_type: 'Bearer',
        expires_in: 3600,
      })
    )
    vi.stubGlobal('fetch', fetcher)
    const tokens = await exchangeTokens({
      grant_type: 'authorization_code',
      code: 'code',
      code_verifier: 'verifier',
      redirect_uri: oauthConfig().redirectUri,
    })
    expect(tokens.refresh_token).toBe('refresh')
    const [url, request] = fetcher.mock.calls[0]
    expect(url).toBe('https://api.supabase.com/v1/oauth/token')
    expect(request.headers.Authorization).toBe(
      `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`
    )
    expect(request.body.get('code_verifier')).toBe('verifier')
  })
  it('does not expose provider error bodies', async () => {
    configure()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('private-provider-details', { status: 400 }))
    )
    await expect(
      exchangeTokens({ grant_type: 'refresh_token', refresh_token: 'secret' })
    ).rejects.toThrow('Reconnect Supabase')
  })
  it('only exposes a small project summary, supporting old and new ref fields', () => {
    const list = parseProjectList([
      {
        id: 'abcdefghijklmnopqrst',
        name: 'Project',
        status: 'ACTIVE_HEALTHY',
        region: 'region',
        database: { password: 'private' },
      },
    ])
    expect(list).toEqual([
      { ref: 'abcdefghijklmnopqrst', name: 'Project', status: 'ACTIVE_HEALTHY', region: 'region' },
    ])
    expect(() => parseProjectList([{ id: '../other' }])).toThrow()
  })
  it('reports a malformed provider list as a provider failure, not invalid browser input', () => {
    const malformed = [{ name: 'Project', status: 'ACTIVE_HEALTHY', region: 'region' }]
    try {
      parseProjectList(malformed)
      expect.unreachable('a project without a reference must not be accepted')
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError)
      expect((error as HttpError).status).toBe(503)
    }
  })
  it('prefers secret keys and never substitutes an anonymous key', () => {
    expect(
      selectSecretKey([
        { name: 'anon', api_key: 'public' },
        { name: 'service_role', api_key: 'legacy' },
        { name: 'default', type: 'secret', api_key: 'secret' },
      ])
    ).toBe('secret')
    expect(selectSecretKey([{ name: 'service_role', api_key: 'legacy' }])).toBe('legacy')
    expect(() => selectSecretKey([{ name: 'anon', api_key: 'public' }])).toThrow()
  })
  it('encrypts tokens with a purpose and browser-specific binding', () => {
    vi.stubEnv('IMPORT_CREDENTIAL_KEY', Buffer.alloc(32, 7).toString('base64'))
    const token = { access_token: 'private-access', refresh_token: 'private-refresh' }
    const bytes = encryptSecret('oauth:browser-a', token)
    expect(bytes.includes(Buffer.from('private-access'))).toBe(false)
    expect(decryptSecret('oauth:browser-a', bytes)).toEqual(token)
    expect(() => decryptSecret('oauth:browser-b', bytes)).toThrow()
    expect(() => decryptSecret('oauth:browser-a', Buffer.alloc(20))).toThrow('Invalid ciphertext')
  })
})

describe('OAuth-only browser destination input', () => {
  it('rejects raw credentials and injected API keys', () => {
    const target = {
      mode: 'oauth',
      projectRef: 'abcdefghijklmnopqrst',
    }
    expect(oauthTargetSchema.parse(target)).toEqual(target)
    expect(() =>
      oauthTargetSchema.parse({
        databaseUrl: 'postgresql://postgres:password@host/postgres',
        supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
        serviceRoleKey: 'secret',
      })
    ).toThrow()
    expect(() => oauthTargetSchema.parse({ ...target, serviceRoleKey: 'secret' })).toThrow()
    expect(() =>
      oauthTargetSchema.parse({ ...target, databaseUrl: 'postgresql://injected' })
    ).toThrow()
  })
})
