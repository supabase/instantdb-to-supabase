import type { Client } from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Plan } from '../src/import/types'
import { importFile } from '../src/workflow/native'
import type { Job } from '../src/workflow/store'

const chunkBytes = 6 * 1024 * 1024
const mocks = vi.hoisted(() => ({
  advance: vi.fn(),
  createUpload: vi.fn(),
  uploadOffset: vi.fn(),
  uploadChunk: vi.fn(),
  read: vi.fn(),
  store: { query: vi.fn(), end: vi.fn() },
}))
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ storage: { getBucket: async () => ({ data: { public: false } }) } }),
}))
vi.mock('../src/workflow/store', () => ({
  advance: mocks.advance,
  connectStore: async () => mocks.store,
}))
vi.mock('../src/workflow/target', () => ({
  targetSchema: () => 'import_test',
  targetBatch: vi.fn(),
}))
vi.mock('../src/workflow/source', () => ({ storageSource: () => ({ read: mocks.read }) }))
vi.mock('../src/workflow/tus', () => ({
  uploadChunkBytes: 6 * 1024 * 1024,
  createUpload: mocks.createUpload,
  uploadOffset: mocks.uploadOffset,
  uploadChunk: mocks.uploadChunk,
}))

describe('resumable destination transfers', () => {
  const file = {
    id: '00000000-0000-4000-8000-000000000001',
    key: 'files/blob',
    path: 'files/blob',
    size: 10 * 1024 * 1024,
    contentType: 'application/octet-stream',
  }
  const job = { id: 'test-job', cursor: { after: '' } } as Job
  const target = {
    databaseUrl: 'postgresql://unused',
    supabaseUrl: 'https://test.supabase.co',
    serviceRoleKey: 'sb_secret_test',
  }
  const blob = {
    id: '00000000-0000-4000-8000-0000000000ff',
    metadata: Buffer.from(JSON.stringify(file)),
    object_key: 'job/blob',
    size: String(file.size),
    etag: null,
  }
  const run = (transfer?: Record<string, unknown>) => {
    const serviceQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [blob] })
      .mockResolvedValueOnce({ rows: transfer ? [transfer] : [] })
      .mockResolvedValue({ rows: [{}] })
    const service = { query: serviceQuery } as unknown as Client
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Client
    return { serviceQuery, promise: importFile(service, db, job, {} as Plan, target) }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.read.mockResolvedValue(Buffer.alloc(chunkBytes))
    mocks.store.query.mockResolvedValue({ rows: [] })
  })

  it('commits the upload URL outside the step transaction so a rollback cannot orphan it', async () => {
    mocks.createUpload.mockResolvedValue('https://test.storage.supabase.co/upload/1')
    const { serviceQuery, promise } = run()
    await promise
    // The transactional client never sees the ledger row; a step ROLLBACK would discard it.
    expect(serviceQuery.mock.calls.filter(([sql]) => String(sql).includes('upload_url'))).toEqual(
      []
    )
    expect(mocks.store.query.mock.calls.map(([sql]) => String(sql))).toEqual([
      expect.stringContaining('INSERT INTO instant_import_service.transfers'),
      expect.stringContaining('SET upload_url=$3'),
    ])
    expect(mocks.store.end).toHaveBeenCalledTimes(2)
    expect(mocks.uploadChunk).toHaveBeenCalledWith(
      'https://test.storage.supabase.co/upload/1',
      target.serviceRoleKey,
      0,
      expect.any(Buffer)
    )
    expect(mocks.advance).toHaveBeenCalledWith(expect.anything(), job, 'files', job.cursor)
  })

  it('resumes a stored upload URL at the server offset without creating a second upload', async () => {
    mocks.uploadOffset.mockResolvedValue(chunkBytes)
    const { promise } = run({ upload_url: 'https://test.storage.supabase.co/upload/1' })
    await promise
    expect(mocks.createUpload).not.toHaveBeenCalled()
    expect(mocks.store.query).not.toHaveBeenCalled()
    expect(mocks.uploadChunk).toHaveBeenCalledWith(
      'https://test.storage.supabase.co/upload/1',
      target.serviceRoleKey,
      chunkBytes,
      expect.any(Buffer)
    )
  })

  it('stops instead of looping when a finished upload produced no destination object', async () => {
    mocks.uploadOffset.mockResolvedValue(file.size)
    const { promise } = run({ upload_url: 'https://test.storage.supabase.co/upload/1' })
    await expect(promise).rejects.toThrow('Storage upload completed without an object')
    expect(mocks.uploadChunk).not.toHaveBeenCalled()
    expect(mocks.advance).not.toHaveBeenCalled()
  })
})
