import { randomBytes } from 'node:crypto'
import { safeSql } from '@supabase/pg-meta'
import type { Client } from 'pg'
import { z } from 'zod'

import { basePath } from '../base-path'
import { connectionSchema } from '../client/contracts'
import { PlatformRetryError } from '../platform-retry'
import { capture, eventId, telemetryId } from '../telemetry/server'
import { credentialConnectMarginMs } from '../workflow/credential-lease'
import { connectStore } from '../workflow/store'
import { decryptSecret, encryptSecret } from './credentials'
import {
  buildAuthorization,
  exchangeTokens,
  managementRequest,
  oauthConfig,
  oauthEnabled,
  parseProjectList,
  projectRefSchema,
  selectSecretKey,
  tokenSchema,
} from './oauth-client'
import { digest, errorResponse, HttpError, sameOrigin, session } from './session'
import { ensureStore } from './store-ready'
import { loginSchema, temporaryConnection } from './temporary-login'

const flowCookieName = 'instant-import-oauth-flow'
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
async function withDb<T>(work: (db: Client) => Promise<T>) {
  const db = await connectStore()
  try {
    return await work(db)
  } finally {
    await db.end()
  }
}
async function lock(db: Client, owner: string) {
  await db.query(safeSql`SET lock_timeout='15s'`)
  await db.query(safeSql`SELECT pg_advisory_lock(hashtextextended($1,1735289203))`, [owner])
}
function flowCookie(value: string, age: number) {
  const secure = new URL(oauthConfig().redirectUri).protocol === 'https:' ? '; Secure' : ''
  // OAuth redirects are cross-site top-level navigations; the import session stays Strict.
  return `${flowCookieName}=${value}; Path=${basePath}/api/supabase; HttpOnly; SameSite=Lax; Max-Age=${age}${secure}`
}
function finish(result: 'connected' | 'denied' | 'error') {
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${oauthConfig().origin}${basePath}?supabase=${result}`,
      'Set-Cookie': flowCookie('', 0),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  })
}
export async function connectSupabase(request: Request) {
  try {
    sameOrigin(request)
    if (request.headers.get('origin') !== oauthConfig().origin)
      throw new HttpError(
        400,
        'Open the importer at its configured OAuth callback origin before connecting'
      )
    const owner = session(request, true),
      flow = buildAuthorization(),
      cookie = randomBytes(32).toString('base64url')
    await withDb(async (db) => {
      await ensureStore(db)
      await lock(db, owner.hash)
      await db.query(
        safeSql`DELETE FROM instant_import_service.oauth_states WHERE session_hash=$1 OR expires_at < now()`,
        [owner.hash]
      )
      await db.query(
        safeSql`INSERT INTO instant_import_service.oauth_states(state_hash,session_hash,cookie_hash,verifier,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')`,
        [
          digest(flow.state),
          owner.hash,
          digest(cookie),
          encryptSecret(`oauth-state:${digest(flow.state)}`, flow.verifier),
        ]
      )
    })
    const headers = new Headers({ 'Cache-Control': 'no-store' })
    if (owner.cookie) headers.append('Set-Cookie', owner.cookie)
    headers.append('Set-Cookie', flowCookie(cookie, 600))
    return Response.json({ url: flow.url }, { headers })
  } catch (error) {
    return errorResponse(error)
  }
}
export async function supabaseCallback(request: Request) {
  try {
    const url = new URL(request.url)
    const state = opaque.parse(url.searchParams.get('state'))
    const cookie = opaque.parse(
      request.headers
        .get('cookie')
        ?.split(';')
        .map((value) => value.trim())
        .find((value) => value.startsWith(`${flowCookieName}=`))
        ?.slice(flowCookieName.length + 1)
    )
    const result = await withDb(async (db) => {
      const params = [digest(state), digest(cookie)]
      const pending = (
        await db.query(
          safeSql`SELECT session_hash FROM instant_import_service.oauth_states WHERE state_hash=$1 AND cookie_hash=$2 AND expires_at>now()`,
          params
        )
      ).rows[0]
      if (!pending)
        throw new HttpError(400, 'OAuth state expired or does not belong to this browser')
      await lock(db, pending.session_hash)
      // Consume before exchanging: a callback cannot be replayed, even after provider errors.
      const flow = (
        await db.query(
          safeSql`DELETE FROM instant_import_service.oauth_states WHERE state_hash=$1 AND cookie_hash=$2 AND expires_at>now() RETURNING *`,
          params
        )
      ).rows[0]
      if (!flow) throw new HttpError(400, 'OAuth state was already consumed')
      if (url.searchParams.has('error')) return 'denied' as const
      const code = z.string().min(1).max(8192).parse(url.searchParams.get('code'))
      const verifier = opaque.parse(decryptSecret(`oauth-state:${digest(state)}`, flow.verifier))
      const tokens = await exchangeTokens(
        {
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: oauthConfig().redirectUri,
        },
        db
      )
      await db.query(
        safeSql`DELETE FROM instant_import_service.oauth_database_credentials WHERE session_hash=$1`,
        [flow.session_hash]
      )
      await saveTokens(db, flow.session_hash, tokens)
      return 'connected' as const
    })
    await capture(
      telemetryId(request),
      result === 'connected'
        ? 'instant_import_connection_completed'
        : 'instant_import_connection_failed',
      { connectionResult: result },
      eventId(`oauth:${state}:${result}`)
    )
    return finish(result)
  } catch {
    console.error('OAuth callback failed (details withheld)')
    try {
      await capture(telemetryId(request), 'instant_import_connection_failed', {
        connectionResult: 'error',
      })
      return finish('error')
    } catch {
      return errorResponse(new Error('OAuth configuration is unavailable'))
    }
  }
}
async function saveTokens(db: Client, owner: string, tokens: z.infer<typeof tokenSchema>) {
  await db.query(
    safeSql`INSERT INTO instant_import_service.oauth_connections(session_hash,tokens,expires_at) VALUES($1,$2,$3) ON CONFLICT(session_hash) DO UPDATE SET tokens=excluded.tokens,expires_at=excluded.expires_at`,
    [
      owner,
      encryptSecret(`oauth-tokens:${owner}`, tokens),
      new Date(Date.now() + tokens.expires_in * 1000),
    ]
  )
}
async function accessToken(db: Client, owner: string, forceRefresh = false) {
  const row = (
    await db.query(
      safeSql`SELECT * FROM instant_import_service.oauth_connections WHERE session_hash=$1`,
      [owner]
    )
  ).rows[0]
  if (!row) throw new HttpError(401, 'Reconnect Supabase to continue')
  let tokens = tokenSchema.parse(decryptSecret(`oauth-tokens:${owner}`, row.tokens))
  if (forceRefresh || new Date(row.expires_at).getTime() < Date.now() + 60000) {
    try {
      tokens = await exchangeTokens(
        {
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
        },
        db
      )
      await saveTokens(db, owner, tokens)
    } catch (error) {
      if (error instanceof HttpError && error.status === 401)
        await db.query(
          safeSql`DELETE FROM instant_import_service.oauth_connections WHERE session_hash=$1`,
          [owner]
        )
      throw error
    }
  }
  return tokens.access_token
}
async function authorizedRequest(db: Client, owner: string, path: string, body?: unknown) {
  const token = await accessToken(db, owner)
  try {
    return await managementRequest(token, path, body, db)
  } catch (error) {
    // A write is never replayed: /cli/login-role mints a credential on every call.
    if (body !== undefined || !(error instanceof HttpError) || error.status !== 401) throw error
    return managementRequest(await accessToken(db, owner, true), path, body, db)
  }
}
export async function supabaseConnection(request: Request) {
  const ready = [
    'IMPORT_JOB_DATABASE_URL',
    'IMPORT_JOB_SUPABASE_URL',
    'IMPORT_JOB_SERVICE_ROLE_KEY',
    'IMPORT_CREDENTIAL_KEY',
  ].every((key) => Boolean(process.env[key]))
  try {
    if (!oauthEnabled())
      return Response.json(
        { ready, configured: false, connected: false, projects: [] },
        { headers: { 'Cache-Control': 'no-store' } }
      )
    let owner: string
    try {
      owner = session(request).hash
    } catch {
      return Response.json(
        { ready, configured: true, connected: false, projects: [] },
        { headers: { 'Cache-Control': 'no-store' } }
      )
    }
    return await withDb(async (db) => {
      const exists = (
        await db.query(
          safeSql`SELECT to_regclass('instant_import_service.oauth_connections') AS relation`
        )
      ).rows[0].relation
      if (!exists)
        return Response.json(
          { ready, configured: true, connected: false, projects: [] },
          { headers: { 'Cache-Control': 'no-store' } }
        )
      await lock(db, owner)
      const hasConnection = (
        await db.query(
          safeSql`SELECT 1 FROM instant_import_service.oauth_connections WHERE session_hash=$1`,
          [owner]
        )
      ).rowCount
      if (!hasConnection)
        return Response.json(
          { ready, configured: true, connected: false, projects: [] },
          { headers: { 'Cache-Control': 'no-store' } }
        )
      const projects = parseProjectList(await authorizedRequest(db, owner, '/projects'))
      return Response.json(
        { ready, configured: true, connected: true, projects },
        { headers: { 'Cache-Control': 'no-store' } }
      )
    })
  } catch (error) {
    if (error instanceof PlatformRetryError) return errorResponse(error)
    const failure = await errorResponse(error).json()
    return Response.json(
      { ready, configured: oauthEnabled(), connected: false, projects: [], error: failure.error },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  }
}
export async function disconnectSupabase(request: Request) {
  try {
    sameOrigin(request)
    const owner = session(request).hash
    await withDb(async (db) => {
      await lock(db, owner)
      await db.query(
        safeSql`DELETE FROM instant_import_service.oauth_states WHERE session_hash=$1`,
        [owner]
      )
      await db.query(
        safeSql`DELETE FROM instant_import_service.oauth_connections WHERE session_hash=$1`,
        [owner]
      )
    })
    return Response.json(
      { connected: false },
      { headers: { 'Set-Cookie': flowCookie('', 0), 'Cache-Control': 'no-store' } }
    )
  } catch (error) {
    return errorResponse(error)
  }
}
export const oauthTargetSchema = z
  .object({ mode: z.literal('oauth'), projectRef: projectRefSchema })
  .strict()
export async function resolveOAuthTarget(owner: string, projectRef: string, force = false) {
  oauthConfig()
  projectRefSchema.parse(projectRef)
  return withDb(async (db) => {
    await lock(db, owner)
    // A disconnected browser cannot keep importing using a cached database password.
    const connected = (
      await db.query(
        safeSql`SELECT 1 FROM instant_import_service.oauth_connections WHERE session_hash=$1`,
        [owner]
      )
    ).rowCount
    if (!connected) throw new HttpError(401, 'Reconnect Supabase to continue')
    const binding = `oauth-database:${owner}:${projectRef}`
    const cached = (
      await db.query(
        safeSql`SELECT credential,expires_at FROM instant_import_service.oauth_database_credentials WHERE session_hash=$1 AND project_ref=$2`,
        [owner, projectRef]
      )
    ).rows[0]
    if (
      !force &&
      cached &&
      new Date(cached.expires_at).getTime() > Date.now() + credentialConnectMarginMs
    )
      return {
        ...connectionSchema.parse(decryptSecret(binding, cached.credential)),
        databaseExpiresAt: new Date(cached.expires_at).getTime(),
      }
    const projects = parseProjectList(await authorizedRequest(db, owner, '/projects'))
    const project = projects.find((p) => p.ref === projectRef)
    if (!project)
      throw new HttpError(403, 'The selected project is not authorized for this connection')
    if (project.status !== 'ACTIVE_HEALTHY')
      throw new HttpError(409, 'Wait until the selected project is healthy before importing')
    const poolers = await authorizedRequest(
      db,
      owner,
      `/projects/${projectRef}/config/database/pooler`
    )
    const serviceRoleKey = selectSecretKey(
      await authorizedRequest(db, owner, `/projects/${projectRef}/api-keys?reveal=true`)
    )
    const issuedAt = Date.now()
    const login = loginSchema.parse(
      await authorizedRequest(db, owner, `/projects/${projectRef}/cli/login-role`, {
        read_only: false,
      })
    )
    const target = temporaryConnection(projectRef, poolers, login, serviceRoleKey, issuedAt)
    const expiresAt = new Date(issuedAt + login.ttl_seconds * 1000)
    if (expiresAt.getTime() <= Date.now() + credentialConnectMarginMs)
      throw new HttpError(
        503,
        'Temporary database credentials expired before connecting. Retry the import.'
      )
    await db.query(
      safeSql`INSERT INTO instant_import_service.oauth_database_credentials(session_hash,project_ref,credential,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT(session_hash,project_ref) DO UPDATE SET credential=excluded.credential,expires_at=excluded.expires_at`,
      [owner, projectRef, encryptSecret(binding, target), expiresAt]
    )
    return target
  })
}
