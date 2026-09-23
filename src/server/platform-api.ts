import { createHash } from 'node:crypto'
import { safeSql } from '@supabase/pg-meta'
import type { Client } from 'pg'

import { PlatformRetryError, retryDeadline } from '../platform-retry'

export function platformScope(url: string) {
  const path = new URL(url).pathname
  const scope = /^\/v1\/(projects|organizations)\/([^/]+)/.exec(path)
  // Supabase meters OAuth requests by app ID plus project/organization, across browser owners.
  return createHash('sha256')
    .update(`${process.env.IMPORT_OAUTH_CLIENT_ID}:${scope ? `${scope[1]}/${scope[2]}` : path}`)
    .digest('hex')
}
export async function platformFetch(
  url: string,
  init: RequestInit,
  db?: Client
): Promise<Response> {
  const key = platformScope(url)
  let failures = 0
  if (db) {
    await db.query(safeSql`SELECT pg_advisory_lock(hashtextextended($1,1735289204))`, [key])
  }
  try {
    if (db) {
      const previous = (
        await db.query(
          safeSql`SELECT retry_at,failures,status FROM instant_import_service.platform_cooldowns WHERE scope=$1`,
          [key]
        )
      ).rows[0]
      if (previous) {
        const retryAt = new Date(previous.retry_at).getTime()
        if (retryAt > Date.now()) throw new PlatformRetryError(previous.status, retryAt)
        failures = previous.failures
      }
    }
    let response: Response
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) })
    } catch {
      const retryAt = retryDeadline(new Headers(), 503, failures)
      await saveCooldown(db, key, retryAt, failures + 1, 503)
      throw new PlatformRetryError(503, retryAt)
    }
    if (response.status === 429 || response.status >= 500) {
      const retryAt = retryDeadline(response.headers, response.status, failures)
      await response.body?.cancel()
      await saveCooldown(db, key, retryAt, failures + 1, response.status)
      throw new PlatformRetryError(response.status, retryAt)
    }
    if (response.ok && response.headers.get('x-ratelimit-remaining') === '0') {
      await saveCooldown(db, key, retryDeadline(response.headers, 429), 0, 429)
    } else if (db) {
      await db.query(
        safeSql`DELETE FROM instant_import_service.platform_cooldowns WHERE scope=$1`,
        [key]
      )
    }
    return response
  } finally {
    if (db)
      await db.query(safeSql`SELECT pg_advisory_unlock(hashtextextended($1,1735289204))`, [key])
  }
}
async function saveCooldown(
  db: Client | undefined,
  key: string,
  retryAt: number,
  failures: number,
  status: number
) {
  if (db)
    await db.query(
      safeSql`INSERT INTO instant_import_service.platform_cooldowns(scope,retry_at,failures,status) VALUES($1,$2,$3,$4) ON CONFLICT(scope) DO UPDATE SET retry_at=excluded.retry_at,failures=excluded.failures,status=excluded.status`,
      [key, new Date(retryAt), failures, status]
    )
}
