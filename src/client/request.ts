import { retryDeadline } from '../platform-retry'

export type RetryOptions = { signal?: AbortSignal; onRetry?: (message: string) => void }
export async function waitForRetry(retryAt: number, signal?: AbortSignal) {
  while (Date.now() < retryAt) {
    signal?.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      const timer = setTimeout(done, Math.min(60000, retryAt - Date.now()))
      const abort = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        reject(signal?.reason)
      }
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
  signal?.throwIfAborted()
}
export async function requestJson<T>(
  url: string,
  init: RequestInit,
  options: RetryOptions = {}
): Promise<T> {
  try {
    for (let attempt = 0; ; attempt++) {
      options.signal?.throwIfAborted()
      const response = await fetch(url, { ...init, signal: options.signal })
      // Proxies and gateways answer with HTML or an empty body, so never surface a parse failure.
      const body: unknown = await response.json().catch(() => undefined)
      const value = (typeof body === 'object' && body !== null ? body : {}) as {
        retryAt?: unknown
        error?: unknown
      }
      if (response.ok) {
        if (body === undefined) throw new Error('The server response could not be read. Try again.')
        return body as T
      }
      // Retry only explicit deferrals from our server, never ambiguous POST/network failures.
      if (
        (response.status === 429 || response.status === 503) &&
        typeof value.retryAt === 'number' &&
        Number.isSafeInteger(value.retryAt) &&
        value.retryAt > 0 &&
        attempt < 5
      ) {
        const retryAt = Math.max(
          value.retryAt,
          retryDeadline(response.headers, response.status, attempt)
        )
        options.onRetry?.(
          `Waiting for Supabase. Retrying at ${new Date(retryAt).toLocaleTimeString()}.`
        )
        await waitForRetry(retryAt, options.signal)
        continue
      }
      throw new Error(
        typeof value.error === 'string' && value.error
          ? value.error
          : `Request failed (HTTP ${response.status}). Try again.`
      )
    }
  } finally {
    options.onRetry?.('')
  }
}
