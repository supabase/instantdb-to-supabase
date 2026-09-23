import { afterEach, describe, expect, it, vi } from 'vitest'

import { storageSource } from '../src/workflow/source'
import type { SourceFile } from '../src/workflow/store'
import { createUpload, uploadChunk, uploadChunkBytes, uploadOffset } from '../src/workflow/tus'

const config = { url: 'https://storage.example', key: 'private-test-key', bucket: 'private-inputs' }
const file = { object_key: 'job/file', size: '10', etag: '"version"' } as SourceFile
const reply = (body: string, status = 206, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { 'content-range': 'bytes 2-4/10', etag: '"version"', ...headers },
  })
afterEach(() => vi.unstubAllGlobals())
describe('immutable bounded Storage reads', () => {
  it('sends a precise authenticated range and version precondition', async () => {
    const fetcher = vi.fn().mockResolvedValue(reply('abc'))
    vi.stubGlobal('fetch', fetcher)
    expect((await storageSource(file, config).read(2, 5)).toString()).toBe('abc')
    expect(fetcher.mock.calls[0][1].headers).toMatchObject({
      apikey: config.key,
      Range: 'bytes=2-4',
      'If-Match': '"version"',
    })
  })
  it.each([
    ['full response', 'abc', 200, {}],
    ['changed version', 'abc', 206, { etag: '"changed"' }],
    ['wrong range', 'abc', 206, { 'content-range': 'bytes 0-2/10' }],
    ['truncation', 'ab', 206, {}],
    ['oversized response', 'abcd', 206, {}],
    ['precondition failure', '', 412, {}],
  ] as const)('rejects %s', async (_name, body, status, headers) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(body, status, headers)))
    await expect(storageSource(file, config).read(2, 5)).rejects.toThrow()
  })
  it('does not fetch empty objects', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    expect((await storageSource({ ...file, size: '0' }, config).read(0, 0)).length).toBe(0)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
describe('resumable upload protocol', () => {
  it('uses the dedicated hosted Storage endpoint and accepts its upload location', async () => {
    const location =
      'https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/upload/resumable/id'
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 201, headers: { location } }))
    vi.stubGlobal('fetch', fetcher)
    expect(
      await createUpload(
        'https://abcdefghijklmnopqrst.supabase.co',
        config.key,
        'bucket',
        'file',
        3
      )
    ).toBe(location)
    expect(fetcher.mock.calls[0][0]).toBe(
      'https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/upload/resumable'
    )
  })
  it.each(['sb_secret_test-key', 'legacy-service-role-jwt'])(
    'authenticates creation, offset reads, and chunks with the project API key (%s)',
    async (key) => {
      const url = `${config.url}/upload`
      const fetcher = vi.fn(async (_url: string, request: RequestInit) => {
        if (new Headers(request.headers).get('apikey') !== key)
          return new Response(null, { status: 401 })
        return new Response(null, {
          status: request.method === 'POST' ? 201 : request.method === 'HEAD' ? 200 : 204,
          headers: { location: url, 'upload-offset': request.method === 'PATCH' ? '3' : '0' },
        })
      })
      vi.stubGlobal('fetch', fetcher)
      expect(await createUpload(config.url, key, config.bucket, 'object', 3)).toBe(url)
      expect(await uploadOffset(url, key)).toBe(0)
      await uploadChunk(url, key, 0, Buffer.from('abc'))
    }
  )
  it.each([404, 410])('allows a fresh upload after an expired URL (%s)', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status })))
    expect(await uploadOffset('https://storage.example/upload', 'key')).toBeNull()
  })
  it('uses the server offset after an upload acknowledgment is lost', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { 'upload-offset': String(uploadChunkBytes) },
        })
      )
    )
    expect(await uploadOffset('https://storage.example/upload', 'key')).toBe(uploadChunkBytes)
  })
  it.each([
    {},
    { 'upload-offset': '-1' },
    { 'upload-offset': '1.5' },
    { 'upload-offset': '9007199254740992' },
  ])('rejects unsafe offsets %j', async (headers) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(null, { status: 200, headers: headers as Record<string, string> })
        )
    )
    await expect(uploadOffset('https://storage.example/upload', 'key')).rejects.toThrow()
  })
  it('rejects a cross-origin upload location before sending bytes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 201,
          headers: { location: 'https://untrusted.example/upload' },
        })
      )
    )
    await expect(createUpload(config.url, config.key, config.bucket, 'object', 10)).rejects.toThrow(
      /origin/
    )
  })
  it('validates the committed chunk offset', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 204, headers: { 'upload-offset': '2' } }))
    )
    await expect(
      uploadChunk('https://storage.example/upload', 'key', 0, Buffer.from('abc'))
    ).rejects.toThrow()
  })
  it('rejects oversized chunks before making a request', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(
      uploadChunk('https://storage.example/upload', 'key', 0, Buffer.alloc(uploadChunkBytes + 1))
    ).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
