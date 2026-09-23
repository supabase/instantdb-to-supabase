import { X509Certificate } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { temporaryConnection } from '../src/server/temporary-login'
import {
  connectTargetWithRefresh,
  targetConnection,
  targetConnectionOptions,
} from '../src/workflow/target'

const clients = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
  options: vi.fn(),
}))
vi.mock('pg', () => ({
  Client: class {
    connect = clients.connect
    query = clients.query
    end = clients.end
    constructor(options: unknown) {
      clients.options(options)
    }
  },
}))
const target = temporaryConnection(
  'a'.repeat(20),
  [
    {
      database_type: 'PRIMARY',
      connection_string: `postgresql://postgres.${'a'.repeat(20)}:pw@aws-0-region.pooler.supabase.com:6543/postgres`,
    },
  ],
  { role: 'cli_login_postgres', password: 'pw:@%?', ttl_seconds: 300 },
  'key'
)
beforeEach(() => {
  vi.clearAllMocks()
  clients.connect.mockResolvedValue(undefined)
  clients.query.mockResolvedValue({ rows: [{ acquired: true }] })
  clients.end.mockResolvedValue(undefined)
})
afterEach(() => vi.restoreAllMocks())
it('verifies TLS using the Supabase CA and decodes the password exactly once', () => {
  const options = targetConnectionOptions(target)
  expect(options).toMatchObject({
    user: `cli_login_postgres.${'a'.repeat(20)}`,
    password: 'pw:@%?',
    port: 5432,
    ssl: { rejectUnauthorized: true },
  })
  expect('ssl' in options && new X509Certificate(options.ssl!.ca).subject).toContain(
    'Supabase Root 2021 CA'
  )
  expect(options.connectionString).toBeUndefined()
})
it('assumes postgres before configuring the session and taking the writer lock', async () => {
  await targetConnection(target)
  expect(clients.query.mock.calls.map((c) => c[0])).toEqual([
    'SET ROLE postgres',
    'SET extra_float_digits=3',
    'SELECT pg_try_advisory_lock(1735289201,1) AS acquired',
  ])
})
it.each([
  Object.assign(new Error('password authentication failed'), { code: '28P01' }),
  new Error('SASL: SCRAM-SERVER-FINAL-MESSAGE: server signature is missing'),
])('renews once on a rotated password before executing SQL', async (error) => {
  clients.connect.mockRejectedValueOnce(error)
  const resolve = vi.fn().mockResolvedValue(target)
  await connectTargetWithRefresh(resolve)
  expect(resolve.mock.calls).toEqual([[false], [true]])
  expect(clients.end).toHaveBeenCalledTimes(1)
  expect(clients.query).toHaveBeenCalledTimes(3)
})
it('stops after a failed renewal connection without an authentication loop', async () => {
  clients.connect.mockRejectedValue(Object.assign(new Error('auth'), { code: '28P01' }))
  const resolve = vi.fn().mockResolvedValue(target)
  await expect(connectTargetWithRefresh(resolve)).rejects.toThrow('auth')
  expect(resolve).toHaveBeenCalledTimes(2)
  expect(clients.end).toHaveBeenCalledTimes(2)
  expect(clients.query).not.toHaveBeenCalled()
})
it.each([
  new Error('certificate verification failed'),
  Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }),
])('does not rotate credentials for network or TLS errors', async (error) => {
  clients.connect.mockRejectedValue(error)
  const resolve = vi.fn().mockResolvedValue(target)
  await expect(connectTargetWithRefresh(resolve)).rejects.toThrow(error.message)
  expect(resolve).toHaveBeenCalledTimes(1)
})
it('does not retry a busy target or an unauthorized role change', async () => {
  clients.query.mockRejectedValueOnce(new Error('permission denied to set role'))
  const resolve = vi.fn().mockResolvedValue(target)
  await expect(connectTargetWithRefresh(resolve)).rejects.toThrow('permission denied')
  expect(resolve).toHaveBeenCalledTimes(1)
  expect(clients.end).toHaveBeenCalledTimes(1)
})
it('leaves legacy operator connections unchanged', async () => {
  const legacy = {
    databaseUrl: 'postgresql://localhost/test',
    supabaseUrl: 'http://localhost',
    serviceRoleKey: 'key',
  }
  expect(targetConnectionOptions(legacy)).toEqual({ connectionString: legacy.databaseUrl })
  await targetConnection(legacy)
  expect(clients.query.mock.calls[0][0]).toBe('SET extra_float_digits=3')
})

it('refreshes credentials that expired after resolution without attempting authentication', async () => {
  const resolve = vi
    .fn()
    .mockResolvedValueOnce({ ...target, databaseExpiresAt: Date.now() - 1 })
    .mockResolvedValue({ ...target, databaseExpiresAt: Date.now() + 300000 })
  await connectTargetWithRefresh(resolve)
  expect(resolve.mock.calls).toEqual([[false], [true]])
  expect(clients.connect).toHaveBeenCalledTimes(1)
})
it('fails safely if renewed credentials also expire before use', async () => {
  const resolve = vi.fn().mockResolvedValue({ ...target, databaseExpiresAt: Date.now() - 1 })
  await expect(connectTargetWithRefresh(resolve)).rejects.toThrow('expired')
  expect(resolve).toHaveBeenCalledTimes(2)
  expect(clients.connect).not.toHaveBeenCalled()
})
it('re-resolves credentials on a later retry after the five-minute window', async () => {
  const resolve = vi
    .fn()
    .mockImplementation(async () => ({ ...target, databaseExpiresAt: Date.now() + 300000 }))
  clients.connect.mockRejectedValueOnce(
    Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })
  )
  await expect(connectTargetWithRefresh(resolve)).rejects.toThrow('offline')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 600000)
  try {
    await connectTargetWithRefresh(resolve)
    expect(resolve.mock.calls).toEqual([[false], [false]])
    expect(clients.connect).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
  }
})
