import type { Client } from 'pg'
import { beforeEach, expect, it, vi } from 'vitest'

const loadEnsureStore = async () => (await import('../src/server/store-ready')).ensureStore
const client = (ready: boolean) =>
  ({ query: vi.fn().mockResolvedValue({ rows: [{ ready }] }) }) as unknown as Client & {
    query: ReturnType<typeof vi.fn>
  }
beforeEach(() => {
  vi.resetModules()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
it('rejects a service project without the migrations and keeps checking', async () => {
  const ensureStore = await loadEnsureStore(),
    db = client(false)
  await expect(ensureStore(db)).rejects.toMatchObject({ status: 503 })
  await expect(ensureStore(db)).rejects.toMatchObject({ status: 503 })
  expect(db.query).toHaveBeenCalledTimes(2)
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('supabase/migrations'))
})
it('never runs DDL and caches a confirmed schema', async () => {
  const ensureStore = await loadEnsureStore(),
    db = client(true)
  await ensureStore(db)
  await ensureStore(db)
  expect(db.query).toHaveBeenCalledTimes(1)
  expect(String(db.query.mock.calls[0][0])).toMatch(/^SELECT /)
})
const bucketClient = (rows: { public: boolean }[]) =>
  ({ query: vi.fn().mockResolvedValue({ rows }) }) as unknown as Client & {
    query: ReturnType<typeof vi.fn>
  }
it('requires the migrated upload bucket instead of creating it', async () => {
  const { ensureSourceBucket } = await import('../src/server/store-ready'),
    db = bucketClient([])
  await expect(ensureSourceBucket(db)).rejects.toMatchObject({ status: 503 })
  expect(String(db.query.mock.calls[0][0])).toMatch(/^SELECT public FROM storage\.buckets/)
  expect(db.query.mock.calls[0][1]).toEqual(['instant-import-inputs'])
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('supabase/migrations'))
})
it('rejects a public upload bucket on every check', async () => {
  const { ensureSourceBucket } = await import('../src/server/store-ready'),
    open = bucketClient([{ public: true }]),
    closed = bucketClient([{ public: false }])
  await expect(ensureSourceBucket(open)).rejects.toThrow('Source bucket must be private')
  await ensureSourceBucket(closed)
  await ensureSourceBucket(closed)
  expect(closed.query).toHaveBeenCalledTimes(2)
})
