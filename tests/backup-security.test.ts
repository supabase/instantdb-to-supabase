import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { PlatformRetryError } from '../src/platform-retry'
import {
  browserJobStatus,
  cancelBrowserJob,
  completeBrowserFile,
  downloadArtifacts,
  registerBrowserFile,
  startBrowserJob,
} from '../src/server/jobs'
import { errorResponse } from '../src/server/session'
import { removeSourceObjects } from '../src/workflow/source'

const mocks = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn(), start: vi.fn() }))
vi.mock('../workflows/import-backup', () => ({ importBackup: vi.fn() }))
vi.mock('workflow/api', () => ({ start: mocks.start }))
vi.mock('../src/workflow/store', () => ({ connectStore: async () => mocks }))
const id = '00000000-0000-4000-8000-000000000001'
const request = (cookie = 'b'.repeat(43), origin = 'http://localhost:3009') =>
  new Request(`http://localhost:3009/api/browser-imports/${id}`, {
    method: 'POST',
    headers: { origin, cookie: `instant-import-session=${cookie}` },
    body: JSON.stringify({ path: 'entities/private.jsonl', size: 1, sha256: 'a'.repeat(64) }),
  })
beforeEach(() => {
  vi.clearAllMocks()
  mocks.query.mockResolvedValue({ rowCount: 0, rows: [] })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
it.each([
  ['status', browserJobStatus],
  ['uploads', registerBrowserFile],
  ['start', startBrowserJob],
  ['cancel', cancelBrowserJob],
  ['reports', downloadArtifacts],
  ['file confirmation', (r: Request, jobId: string) => completeBrowserFile(r, jobId, id)],
] as const)(
  'rejects another session before accessing %s or taking its lock',
  async (_, handler) => {
    const response = await handler(request(), id)
    expect(response.status).toBe(404)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(mocks.query).toHaveBeenCalledOnce()
    expect(mocks.query.mock.calls[0][0]).toContain('session_hash=$2')
    expect(mocks.start).not.toHaveBeenCalled()
  }
)
it.each([registerBrowserFile, startBrowserJob, cancelBrowserJob])(
  'rejects cross-origin mutations before accessing a job',
  async (handler) => {
    expect((await handler(request('b'.repeat(43), 'https://attacker.example'), id)).status).toBe(
      403
    )
    expect(mocks.query).not.toHaveBeenCalled()
  }
)
it('does not log driver messages, stack traces, or causes', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const response = errorResponse(
    new Error('postgresql://secret and private source row', { cause: 'private' })
  )
  expect(await response.text()).not.toContain('private')
  expect(JSON.stringify(log.mock.calls)).not.toContain('secret')
  expect(JSON.stringify(log.mock.calls)).not.toContain('private')
})
const config = {
  url: 'https://service.supabase.co',
  key: 'server-only-secret',
  bucket: 'instant-import-inputs',
}
it('uses exact object keys, server credentials and bounded requests for Storage deletion', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('[]'))
  vi.stubGlobal('fetch', fetcher)
  await removeSourceObjects([`${id}/file`], config)
  const [url, init] = fetcher.mock.calls[0]
  expect(url).toBe(`${config.url}/storage/v1/object/${config.bucket}`)
  expect(init.method).toBe('DELETE')
  expect(init.redirect).toBe('error')
  expect(JSON.parse(init.body)).toEqual({ prefixes: [`${id}/file`] })
  expect(init.headers.Authorization).toBe(`Bearer ${config.key}`)
})
it.each([[], ['../other-job'], Array(101).fill('job/file')])(
  'rejects unsafe deletion batches',
  async (keys) => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(removeSourceObjects(keys, config)).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  }
)
it('preserves Retry-After when Storage limits cleanup', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response('private error', { status: 429, headers: { 'Retry-After': '120' } })
      )
  )
  const before = Date.now()
  const error = await removeSourceObjects(['job/file'], config).catch((e) => e)
  expect(error).toBeInstanceOf(PlatformRetryError)
  expect(error.retryAt).toBeGreaterThanOrEqual(before + 120000)
  expect(error.message).not.toContain('private')
})
it('retries an already deleted object safely', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]')))
  await expect(removeSourceObjects(['job/missing'], config)).resolves.toBeUndefined()
})
