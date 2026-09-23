import { z } from 'zod'

import type { Connection } from '../client/contracts'
import { HttpError } from './session'

export const loginSchema = z.object({
  role: z
    .string()
    .regex(/^cli_login_[a-z0-9_]+$/)
    .max(63),
  password: z.string().min(1),
  ttl_seconds: z.number().int().min(30).max(86400),
})
const poolerSchema = z.array(
  z.object({
    database_type: z.string(),
    connection_string: z.string().optional(),
    connectionString: z.string().optional(),
  })
)
/** The API supplies routing; never accept a browser-supplied host or connection options. */
export function temporaryConnection(
  projectRef: string,
  poolers: unknown,
  login: unknown,
  serviceRoleKey: string,
  issuedAt = Date.now()
): Connection {
  if (!/^[a-z0-9]{20}$/.test(projectRef)) throw new Error('Invalid project reference')
  const credential = loginSchema.parse(login)
  const primary = poolerSchema.parse(poolers).filter((p) => p.database_type === 'PRIMARY')
  for (const pooler of primary) {
    let url: URL
    try {
      url = new URL(pooler.connection_string ?? pooler.connectionString ?? '')
    } catch {
      continue
    }
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !/^[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname) ||
      decodeURIComponent(url.username) !== `postgres.${projectRef}` ||
      url.pathname !== '/postgres' ||
      url.search ||
      url.hash ||
      !['5432', '6543'].includes(url.port)
    )
      continue
    // Supavisor session mode on 5432 preserves transactions and advisory locks.
    const connection = new URL(`postgresql://${url.hostname}:5432/postgres`)
    connection.username = `${credential.role}.${projectRef}`
    connection.password = encodeURIComponent(credential.password)
    connection.searchParams.set('sslmode', 'verify-full')
    return {
      databaseUrl: connection.href,
      databaseRole: 'postgres',
      databaseExpiresAt: issuedAt + credential.ttl_seconds * 1000,
      supabaseUrl: `https://${projectRef}.supabase.co`,
      serviceRoleKey,
    }
  }
  throw new HttpError(
    409,
    'A supported primary Supabase pooler is unavailable. Wait until the project is ready and retry.'
  )
}
