import type { Client } from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Plan } from '../src/import/types'
import { importFile } from '../src/workflow/native'
import type { Job } from '../src/workflow/store'

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  advance: vi.fn(),
  createUpload: vi.fn(),
}))
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    storage: {
      getBucket: async () => ({ data: { public: false } }),
      from: () => ({ upload: mocks.upload }),
    },
  }),
}))
vi.mock('../src/workflow/store', () => ({ advance: mocks.advance }))
vi.mock('../src/workflow/target', () => ({ targetSchema: () => 'import_test' }))
vi.mock('../src/workflow/tus', () => ({ createUpload: mocks.createUpload }))

describe('empty destination files', () => {
  beforeEach(() => vi.clearAllMocks())
  const file = {
    id: '00000000-0000-4000-8000-000000000001',
    key: 'empty.txt',
    path: 'original/empty.txt',
    size: 0,
    contentType: 'text/plain',
  }
  const job = { id: 'test-job', cursor: { after: '' } } as Job
  const run = () => {
    const service = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ metadata: Buffer.from(JSON.stringify(file)) }] })
        .mockResolvedValue({ rows: [{}] }),
    } as unknown as Client
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Client
    return importFile(service, db, job, {} as Plan, {
      databaseUrl: 'postgresql://unused',
      supabaseUrl: 'https://test.supabase.co',
      serviceRoleKey: 'sb_secret_test',
    })
  }
  it('uses a zero-byte standard upload with original metadata and then checkpoints for verification', async () => {
    mocks.upload.mockResolvedValue({ error: null })
    await run()
    expect(mocks.upload).toHaveBeenCalledWith('empty.txt', Buffer.alloc(0), {
      contentType: 'text/plain',
      upsert: false,
      metadata: { original_path: 'original/empty.txt' },
    })
    expect(mocks.createUpload).not.toHaveBeenCalled()
    expect(mocks.advance).toHaveBeenCalledWith(expect.anything(), job, 'files', job.cursor)
  })
  it('retains the checkpoint on an API failure without exposing the provider message', async () => {
    mocks.upload.mockResolvedValue({ error: { statusCode: '503', message: 'private details' } })
    await expect(run()).rejects.toThrow('Empty Storage upload failed (503)')
    expect(mocks.advance).not.toHaveBeenCalled()
  })
})
