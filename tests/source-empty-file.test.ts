import { afterEach, describe, expect, it, vi } from 'vitest'

import { ensureEmptySource } from '../src/workflow/source'

const source = { url: 'https://example.supabase.co', key: 'private-key', bucket: 'inputs' }
const head = (size = '0', etag = 'version-1') =>
  new Response(null, { headers: { 'content-length': size, etag } })
afterEach(() => vi.unstubAllGlobals())

describe('empty source uploads', () => {
  it('creates an empty object through standard upload and verifies its version', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(head())
    vi.stubGlobal('fetch', fetcher)
    expect(await ensureEmptySource('job/file', source)).toBe('version-1')
    expect(fetcher.mock.calls[1]).toEqual([
      'https://example.supabase.co/storage/v1/object/inputs/job/file',
      expect.objectContaining({
        method: 'POST',
        body: new Uint8Array(0),
        headers: expect.objectContaining({ 'x-upsert': 'false' }),
      }),
    ])
    expect(fetcher.mock.calls.every(([url]) => !String(url).includes('resumable'))).toBe(true)
  })
  it('recovers a completed upload after a lost response without overwriting it', async () => {
    const fetcher = vi.fn().mockResolvedValue(head())
    vi.stubGlobal('fetch', fetcher)
    expect(await ensureEmptySource('job/file', source)).toBe('version-1')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each([head('1'), head('0', ''), new Response(null)])(
    'rejects an unverified object',
    async (response) => {
      const fetcher = vi.fn().mockResolvedValue(response)
      vi.stubGlobal('fetch', fetcher)
      await expect(ensureEmptySource('job/file', source)).rejects.toThrow('verification')
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  )
  it('does not create an object when lookup fails transiently', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }))
    vi.stubGlobal('fetch', fetcher)
    await expect(ensureEmptySource('job/file', source)).rejects.toThrow('lookup failed (503)')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('propagates upload failures without including provider response contents', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(new Response('private details', { status: 503 }))
    )
    await expect(ensureEmptySource('job/file', source)).rejects.toThrow(
      'Empty source upload failed (503)'
    )
  })
})
