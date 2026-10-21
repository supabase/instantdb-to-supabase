import { expect, test, type Page } from '@playwright/test'

import { basePath } from '../src/base-path'
import { mockSupabaseConnection } from './oauth-fixtures'
import { recordPostHog } from './posthog-fixtures'

const carriedId = '00000000-0000-4000-8000-000000000001'

async function deviceStorage(page: Page) {
  const browserCookies = await page.context().cookies()
  const storage = await page.evaluate(() => [
    ...Object.keys(localStorage),
    ...Object.keys(sessionStorage),
    document.cookie,
  ])
  return [...browserCookies.map((cookie) => cookie.name), ...storage].filter((name) =>
    /ph_|posthog|instant-import-analytics/i.test(name)
  )
}

test('captures in memory with one ID per visit and stores nothing on the device', async ({
  page,
}) => {
  const posthog = await recordPostHog(page)
  await mockSupabaseConnection(page, false)
  const connectBodies: unknown[] = []
  await page.route('**/api/supabase/connect', (route) => {
    connectBodies.push(route.request().postDataJSON())
    return route.fulfill({
      status: 400,
      json: { error: 'private-account@example.com: secret connection failure' },
    })
  })
  await page.goto(`${basePath}?utm_source=docs`)
  await expect(page.getByRole('button', { name: 'Connect Supabase', exact: true })).toBeEnabled()
  await expect.poll(() => posthog.events.filter((e) => e.event === '$pageview').length).toBe(1)
  await page.getByRole('button', { name: 'Connect Supabase', exact: true }).click()
  await expect(
    page.getByText('private-account@example.com: secret connection failure')
  ).toBeVisible()
  await expect
    .poll(() => posthog.events.map((e) => e.event))
    .toContain('instant_import_action_failed')
  const pageview = posthog.events.find((e) => e.event === '$pageview')!
  expect(pageview.properties).toMatchObject({
    app: 'instant-import',
    $current_url: expect.stringContaining('?utm_source=docs'),
  })
  expect(posthog.events.find((e) => e.event === 'instant_import_connection_clicked')).toMatchObject(
    { properties: { connectionAction: 'connect', app: 'instant-import' } }
  )
  expect(posthog.events.find((e) => e.event === 'instant_import_action_failed')).toMatchObject({
    properties: { importAction: 'connect' },
  })
  expect(new Set(posthog.events.map((e) => e.properties.distinct_id))).toEqual(
    new Set([pageview.properties.distinct_id])
  )
  expect(connectBodies).toEqual([{ telemetryId: pageview.properties.distinct_id }])
  expect(JSON.stringify(posthog.events)).not.toMatch(/private-account|secret/)
  expect(posthog.paths.every((path) => /^\/(e|i\/v0\/e|batch)\/?$/.test(path))).toBe(true)
  expect(await deviceStorage(page)).toEqual([])
})

test('adopts a carried ID only on the OAuth return and strips the fragment', async ({ page }) => {
  const posthog = await recordPostHog(page)
  await mockSupabaseConnection(page, false)
  await page.goto(`${basePath}?supabase=connected#telemetryId=${carriedId}`)
  await expect.poll(() => posthog.events.filter((e) => e.event === '$pageview').length).toBe(1)
  expect(posthog.events[0].properties.distinct_id).toBe(carriedId)
  expect(posthog.events[0].properties.$current_url).not.toContain('#')
  expect(page.url()).not.toContain('telemetryId')

  const direct = await page.context().newPage()
  const directPostHog = await recordPostHog(direct)
  await mockSupabaseConnection(direct, false)
  await direct.goto(`${basePath}#telemetryId=${carriedId}`)
  await expect
    .poll(() => directPostHog.events.filter((e) => e.event === '$pageview').length)
    .toBe(1)
  expect(directPostHog.events[0].properties.distinct_id).not.toBe(carriedId)
  expect(direct.url()).not.toContain('telemetryId')
})

test('privacy signals suppress capture without disabling the connection flow', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: true })
  )
  const posthog = await recordPostHog(page)
  await mockSupabaseConnection(page, false)
  const connectBodies: unknown[] = []
  await page.route('**/api/supabase/connect', (route) => {
    connectBodies.push(route.request().postDataJSON())
    return route.fulfill({ status: 400, json: { error: 'Connection refused' } })
  })
  await page.goto(basePath)
  await page.getByRole('button', { name: 'Connect Supabase', exact: true }).click()
  await expect(page.getByText('Connection refused')).toBeVisible()
  expect(posthog.paths).toHaveLength(0)
  expect(connectBodies).toEqual([{}])
})
