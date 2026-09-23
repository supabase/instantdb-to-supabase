import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { registerBrowserFile } from '../src/server/jobs'
import { digest } from '../src/server/session'

const mocks = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn(), empty: vi.fn(), sign: vi.fn() }))
vi.mock('../workflows/import-backup', () => ({ importBackup: vi.fn() }))
vi.mock('../src/workflow/store', () => ({ connectStore: async () => mocks }))
vi.mock('../src/workflow/source', () => ({
  ensureEmptySource: mocks.empty,
  sourceConfig: () => ({
    url: 'https://example.supabase.co',
    key: 'private-key',
    bucket: 'inputs',
  }),
}))
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ storage: { from: () => ({ createSignedUploadUrl: mocks.sign }) } }),
}))
const id = '00000000-0000-4000-8000-000000000001'
const fileId = '00000000-0000-4000-8000-000000000002'
let file: {
  id: string
  path: string
  size: string
  sha256: string
  object_key: string
  etag: string | null
}
let authorized: boolean
const request = () =>
  new Request(`http://localhost:3009/api/browser-imports/${id}/files`, {
    method: 'POST',
    headers: {
      origin: 'http://localhost:3009',
      cookie: `instant-import-session=${'a'.repeat(43)}`,
    },
    body: JSON.stringify({ path: file.path, size: Number(file.size), sha256: file.sha256 }),
  })
beforeEach(() => {
  vi.clearAllMocks()
  authorized = true
  file = {
    id: fileId,
    path: 'entities/empty.jsonl',
    size: '0',
    sha256: digest(''),
    object_key: `${id}/${fileId}`,
    etag: null,
  }
  mocks.empty.mockResolvedValue('empty-version')
  mocks.sign.mockResolvedValue({ data: { token: 'signed-token' } })
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] }
    if (sql.includes('browser_jobs'))
      return { rowCount: authorized ? 1 : 0, rows: [{ phase: 'uploading' }] }
    if (sql.startsWith('SELECT * FROM instant_import_service.files')) return { rows: [{ ...file }] }
    return { rowCount: 1, rows: [] }
  })
})
afterEach(() => vi.restoreAllMocks())
it('registers an empty file as uploaded so existing browsers skip TUS', async () => {
  const response = await registerBrowserFile(request(), id)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ uploaded: true, id: fileId })
  expect(mocks.empty).toHaveBeenCalledWith(file.object_key)
  expect(mocks.sign).not.toHaveBeenCalled()
  expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('SET etag=$3'), [
    id,
    fileId,
    'empty-version',
  ])
})
it('preserves resumable uploads for nonempty files', async () => {
  file.size = '1'
  expect(await (await registerBrowserFile(request(), id)).json()).toMatchObject({
    uploaded: false,
    token: 'signed-token',
  })
  expect(mocks.empty).not.toHaveBeenCalled()
})
it('does not recreate an already verified empty file', async () => {
  file.etag = 'existing'
  expect(await (await registerBrowserFile(request(), id)).json()).toMatchObject({ uploaded: true })
  expect(mocks.empty).not.toHaveBeenCalled()
})
it('checks ownership before creating an empty object', async () => {
  authorized = false
  expect((await registerBrowserFile(request(), id)).status).toBe(404)
  expect(mocks.empty).not.toHaveBeenCalled()
})
it('leaves the file retryable when empty upload verification fails', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mocks.empty.mockRejectedValue(new Error('verification failed'))
  expect((await registerBrowserFile(request(), id)).status).toBe(503)
  expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('SET etag=$3'))).toBe(false)
  expect(mocks.sign).not.toHaveBeenCalled()
})
