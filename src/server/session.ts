import { createHash, randomBytes } from 'node:crypto'
import { safeSql } from '@supabase/pg-meta'
import type { Client } from 'pg'
import { z } from 'zod'

import { PlatformRetryError } from '../platform-retry'
import { oauthConfig } from './oauth-client'

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex')
function sessionToken(request: Request) {
  const value = request.headers
    .get('cookie')
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('instant-import-session='))
    ?.split('=')[1]
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null
}
function secure(request: Request) {
  // A TLS-terminating proxy hands Next an http URL, so the configured callback decides.
  try {
    return new URL(oauthConfig().redirectUri).protocol === 'https:'
  } catch {
    return new URL(request.url).protocol === 'https:'
  }
}
export function session(request: Request, create = false) {
  const value = sessionToken(request)
  if (value) return { hash: digest(value), cookie: null }
  if (!create) throw new HttpError(404, 'Import not found in this browser')
  const token = randomBytes(32).toString('base64url')
  return {
    hash: digest(token),
    cookie: `instant-import-session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure(request) ? '; Secure' : ''}`,
  }
}
/** Endpoints that create work cannot mint a session: the OAuth connection is bound to one. */
export function connectedSession(request: Request) {
  const value = sessionToken(request)
  if (!value) throw new HttpError(401, 'Connect Supabase before starting an import')
  return { hash: digest(value) }
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get('origin')
  const host = request.headers.get('host') ?? new URL(request.url).host
  if (
    !origin ||
    !['http:', 'https:'].includes(new URL(origin).protocol) ||
    new URL(origin).host !== host
  )
    throw new HttpError(403, 'Open the importer in this browser and try again')
}
export async function ownedJob(db: Client, request: Request, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, 'Import not found')
  const result = await db.query(
    safeSql`SELECT b.*,j.phase,j.cancel_requested FROM instant_import_service.browser_jobs b JOIN instant_import_service.jobs j ON j.id=b.job_id WHERE b.job_id=$1 AND b.session_hash=$2`,
    [id, session(request).hash]
  )
  if (!result.rowCount) throw new HttpError(404, 'Import not found in this browser')
  return result.rows[0]
}
export async function jsonBody(request: Request, max = 64 * 1024) {
  const reader = request.body?.getReader()
  if (!reader) throw new HttpError(400, 'Request is empty')
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const value = await reader.read()
    if (value.done) break
    size += value.value.length
    if (size > max) {
      await reader.cancel()
      throw new HttpError(413, 'Request is too large')
    }
    chunks.push(value.value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    throw new HttpError(400, 'Request is not valid JSON')
  }
}
export function errorResponse(error: unknown) {
  if (error instanceof PlatformRetryError)
    return Response.json(
      { error: error.message, retryAt: error.retryAt },
      {
        status: error.status === 429 ? 429 : 503,
        headers: {
          'Cache-Control': 'no-store',
          'Retry-After': String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1000))),
        },
      }
    )
  if (!(error instanceof HttpError) && !(error instanceof z.ZodError))
    // Driver errors can contain source values, SQL parameters, or connection secrets.
    console.error('Import request failed (details withheld)')
  return Response.json(
    {
      error:
        error instanceof z.ZodError
          ? 'Check the submitted fields and try again.'
          : error instanceof HttpError
            ? error.message
            : 'The request did not finish. Check the connection details and retry.',
    },
    {
      status: error instanceof z.ZodError ? 400 : error instanceof HttpError ? error.status : 503,
      headers: { 'Cache-Control': 'no-store' },
    }
  )
}
