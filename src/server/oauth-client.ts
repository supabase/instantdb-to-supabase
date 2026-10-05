import { createHash, randomBytes } from 'node:crypto'
import type { Client } from 'pg'
import { z } from 'zod'

import { basePath } from '../base-path'
import { platformFetch } from './platform-api'
import { HttpError } from './session'

const platform = 'https://api.supabase.com/v1'
export function oauthEnabled() {
  return !!(
    process.env.IMPORT_OAUTH_CLIENT_ID &&
    process.env.IMPORT_OAUTH_CLIENT_SECRET &&
    process.env.IMPORT_OAUTH_REDIRECT_URI
  )
}
export function oauthConfig() {
  if (!oauthEnabled())
    throw new HttpError(503, 'Connect Supabase is not configured for this importer')
  const redirect = new URL(process.env.IMPORT_OAUTH_REDIRECT_URI!)
  if (
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash ||
    redirect.pathname !== `${basePath}/api/supabase/callback` ||
    (redirect.protocol !== 'https:' &&
      !(redirect.protocol === 'http:' && redirect.hostname === 'localhost'))
  )
    throw new Error('Invalid OAuth redirect configuration')
  return {
    clientId: process.env.IMPORT_OAUTH_CLIENT_ID!,
    clientSecret: process.env.IMPORT_OAUTH_CLIENT_SECRET!,
    redirectUri: redirect.href,
    origin: redirect.origin,
  }
}
export function buildAuthorization() {
  const config = oauthConfig(),
    state = randomBytes(32).toString('base64url'),
    verifier = randomBytes(32).toString('base64url')
  const url = new URL(`${platform}/oauth/authorize`)
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString()
  return { state, verifier, url: url.href }
}
export const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.literal('Bearer'),
})
export async function exchangeTokens(parameters: Record<string, string>, db?: Client) {
  const config = oauthConfig()
  const result = await platformFetch(
    `${platform}/oauth/token`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(parameters),
      signal: AbortSignal.timeout(15000),
      cache: 'no-store',
      redirect: 'error',
    },
    db
  )
  if (!result.ok)
    throw new HttpError(
      result.status >= 500 || result.status === 429 ? 503 : 401,
      'Reconnect Supabase to continue'
    )
  return tokenSchema.parse(await result.json())
}
export async function managementRequest(
  accessToken: string,
  path: string,
  body?: unknown,
  db?: Client
) {
  const result = await platformFetch(
    `${platform}${path}`,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
      cache: 'no-store',
      redirect: 'error',
    },
    db
  )
  if (result.status === 401) throw new HttpError(401, 'Reconnect Supabase to continue')
  if (result.status === 403)
    throw new HttpError(
      403,
      'Supabase access is missing. Reconnect and authorize the project and required permissions.'
    )
  if (!result.ok)
    throw new HttpError(503, 'Could not reach the Supabase Management API. Try again shortly.')
  return result.json() as Promise<unknown>
}
export const projectRefSchema = z.string().regex(/^[a-z0-9]{20}$/)
const projectSchema = z.object({
  ref: projectRefSchema.optional(),
  id: projectRefSchema.optional(),
  name: z.string(),
  status: z.string(),
  region: z.string(),
})
export function parseProjectList(value: unknown) {
  // A malformed provider response is a provider problem, not invalid browser input.
  const unexpected = () =>
    new HttpError(503, 'Supabase returned an unexpected project list. Try again shortly.')
  const parsed = z.array(projectSchema).safeParse(value)
  if (!parsed.success) throw unexpected()
  return parsed.data.map((project) => {
    const ref = project.ref ?? project.id
    if (!ref) throw unexpected()
    return { ref, name: project.name, status: project.status, region: project.region }
  })
}
export function selectSecretKey(value: unknown) {
  const keys = z
    .array(
      z.object({ name: z.string(), type: z.string().nullish(), api_key: z.string().nullish() })
    )
    .parse(value)
  const key =
    keys.find((key) => key.type === 'secret' && key.api_key)?.api_key ??
    keys.find((key) => key.name === 'service_role' && key.api_key)?.api_key
  if (!key)
    throw new HttpError(
      409,
      'The project has no available secret or service-role key. Configure a project API key in Supabase before importing.'
    )
  return key
}
