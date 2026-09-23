import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { requestJson, waitForRetry } from '../src/client/request'

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('waits for Retry-After then resumes without losing the request body', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        { retryAt: Date.now() + 120000 },
        { status: 429, headers: { 'Retry-After': '120' } }
      )
    )
    .mockResolvedValue(Response.json({ ok: true }))
  vi.stubGlobal('fetch', fetcher)
  const notice = vi.fn()
  const pending = requestJson(
    '/api/browser-imports',
    { method: 'POST', body: 'input' },
    { onRetry: notice }
  )
  await vi.advanceTimersByTimeAsync(119999)
  expect(fetcher).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(await pending).toEqual({ ok: true })
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(fetcher.mock.calls[1][1].body).toBe('input')
  expect(notice).toHaveBeenLastCalledWith('')
})
it.each(['body', 'header'])('preserves a one-hour %s deadline', async (source) => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        { retryAt: Date.now() + (source === 'body' ? 3600000 : 1000) },
        { status: 429, headers: { 'Retry-After': source === 'header' ? '3600' : '1' } }
      )
    )
    .mockResolvedValue(Response.json({ ok: true }))
  vi.stubGlobal('fetch', fetcher)
  const pending = requestJson('/api/browser-imports', { method: 'POST' })
  await vi.advanceTimersByTimeAsync(3599999)
  expect(fetcher).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(await pending).toEqual({ ok: true })
})
it('cancels a waiting retry without another request', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { retryAt: Date.now() + 120000 },
          { status: 429, headers: { 'Retry-After': '120' } }
        )
      )
  )
  const abort = new AbortController()
  const pending = requestJson('/api/supabase/connection', {}, { signal: abort.signal }).catch(
    (error) => error
  )
  await vi.advanceTimersByTimeAsync(100)
  abort.abort()
  expect(await pending).toMatchObject({ name: 'AbortError' })
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('does not retry ambiguous server failures or permanent rejections', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ error: 'failed' }, { status: 503 }))
  vi.stubGlobal('fetch', fetcher)
  await expect(requestJson('/api/browser-imports', { method: 'POST' })).rejects.toThrow('failed')
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('bounds automatic retries when the provider stays unavailable', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          Response.json(
            { retryAt: Date.now() + 1000, error: 'still limited' },
            { status: 429, headers: { 'Retry-After': '1' } }
          )
        )
      )
  )
  const pending = requestJson('/api/supabase/connection', {}).catch((error) => error)
  await vi.advanceTimersByTimeAsync(6000)
  expect(await pending).toMatchObject({ message: 'still limited' })
  expect(fetch).toHaveBeenCalledTimes(6)
})
it('does not overflow long browser timeouts', async () => {
  const abort = new AbortController()
  const pending = waitForRetry(Date.now() + 3e9, abort.signal).catch((error) => error)
  await vi.advanceTimersByTimeAsync(60000)
  expect(vi.getTimerCount()).toBe(1)
  abort.abort()
  expect(await pending).toMatchObject({ name: 'AbortError' })
})
