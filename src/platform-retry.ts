/** Only safe status and timing metadata may cross the Workflow/browser boundary. */
export class PlatformRetryError extends Error {
  constructor(
    public status: number,
    public retryAt: number
  ) {
    super(
      status === 429
        ? 'Supabase is limiting requests. Wait for the retry window before trying again.'
        : 'Supabase is temporarily unavailable. Wait for the retry window before trying again.'
    )
  }
}
const relativeWindow = 86400000
function seconds(value: string | null) {
  if (!value || !/^\d+$/.test(value.trim())) return undefined
  const ms = Number(value) * 1000
  return Number.isSafeInteger(ms) && ms < 8e15 ? ms : undefined
}
function rateLimitReset(value: string | null, now: number) {
  const ms = seconds(value)
  // A value beyond any plausible relative window is an absolute epoch-seconds timestamp.
  return ms !== undefined && ms > relativeWindow ? Math.max(0, ms - now) : ms
}
export function retryDeadline(headers: Headers, status: number, failures = 0, now = Date.now()) {
  const retry = headers.get('retry-after')
  let delay = seconds(retry)
  if (delay === undefined && retry && /^[A-Za-z]{3},/.test(retry)) {
    const date = Date.parse(retry)
    const serverDate = Date.parse(headers.get('date') ?? '')
    if (Number.isFinite(date))
      delay = Math.max(0, date - (Number.isFinite(serverDate) ? serverDate : now))
  }
  const reset = rateLimitReset(headers.get('x-ratelimit-reset'), now)
  const delays = [delay, reset].filter((value): value is number => value !== undefined)
  const fallback = Math.min(
    status === 429 ? 900000 : 60000,
    (status === 429 ? 60000 : 2000) * 2 ** Math.min(failures, 10)
  )
  const chosen = Math.max(1000, delays.length ? Math.max(...delays) : fallback)
  return now + chosen + Math.floor(Math.random() * 1000)
}
