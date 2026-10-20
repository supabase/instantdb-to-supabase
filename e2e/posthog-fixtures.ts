import { gunzipSync } from 'node:zlib'
import type { Page, Request } from '@playwright/test'

type Captured = {
  event: string
  properties: { distinct_id: string } & Record<string, unknown>
}

function decode(request: Request): Captured[] {
  const body = request.postDataBuffer()
  if (!body?.length) return []
  const gzipped = body[0] === 0x1f && body[1] === 0x8b
  const value = JSON.parse((gzipped ? gunzipSync(body) : body).toString())
  return Array.isArray(value) ? value : (value.batch ?? [value])
}
export async function recordPostHog(page: Page) {
  // posthog-js drops events from automation (HeadlessChrome UA and brand hints, webdriver flag).
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent.replace('HeadlessChrome', 'Chrome')
    Object.defineProperty(navigator, 'userAgent', { get: () => userAgent })
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
    Object.defineProperty(navigator, 'userAgentData', { get: () => undefined })
  })
  const paths: string[] = []
  const events: Captured[] = []
  await page.route('https://ph.supabase.com/**', (route) => {
    paths.push(new URL(route.request().url()).pathname)
    events.push(...decode(route.request()))
    return route.fulfill({ json: { status: 1 } })
  })
  return { paths, events }
}
