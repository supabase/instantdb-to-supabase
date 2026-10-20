import { expect, test } from '@playwright/test'

import { basePath } from '../src/base-path'
import { mockSupabaseConnection } from './oauth-fixtures'

test('tracks one sanitized pageview and explicit actions without leaking OAuth errors', async ({
  page,
}) => {
  const events: { action: string; properties: Record<string, unknown> }[] = []
  await page.route('**/api/telemetry', (route) => {
    events.push(route.request().postDataJSON())
    return route.fulfill({ status: 204 })
  })
  await mockSupabaseConnection(page, false)
  await page.route('**/api/supabase/connect', (route) =>
    route.fulfill({
      status: 400,
      json: { error: 'private-account@example.com: secret connection failure' },
    })
  )
  await page.goto(`${basePath}?sensitive=never-capture-this`)
  await expect(page.getByRole('button', { name: 'Connect Supabase', exact: true })).toBeEnabled()
  await expect.poll(() => events.filter((event) => event.action === '$pageview').length).toBe(1)
  await page.getByRole('button', { name: 'Connect Supabase', exact: true }).click()
  await expect(
    page.getByText('private-account@example.com: secret connection failure')
  ).toBeVisible()
  await expect
    .poll(() => events.map((event) => event.action))
    .toContain('instant_import_action_failed')
  expect(events).toContainEqual({
    action: 'instant_import_connection_clicked',
    properties: { connectionAction: 'connect' },
  })
  expect(events).toContainEqual({
    action: 'instant_import_action_failed',
    properties: { importAction: 'connect' },
  })
  expect(events.filter((event) => event.action === '$pageview')).toHaveLength(1)
  expect(JSON.stringify(events)).not.toMatch(/private-account|secret|sensitive|never-capture-this/)
})

test('browser privacy signals do not suppress client capture', async ({ page }) => {
  // Consent is managed by the host site, not by DNT/GPC in this app.
  await page.setExtraHTTPHeaders({ DNT: '1', 'Sec-GPC': '1' })
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: true })
    Object.defineProperty(navigator, 'doNotTrack', { value: '1' })
  })
  const events: unknown[] = []
  await page.route('**/api/telemetry', (route) => {
    events.push(route.request().postDataJSON())
    return route.fulfill({ status: 204 })
  })
  await mockSupabaseConnection(page, false)
  await page.route('**/api/supabase/connect', (route) =>
    route.fulfill({ status: 400, json: { error: 'Connection refused' } })
  )
  await page.goto(basePath)
  await page.getByRole('button', { name: 'Connect Supabase', exact: true }).click()
  await expect(page.getByText('Connection refused')).toBeVisible()
  await expect
    .poll(() => events.map((event) => (event as { action: string }).action))
    .toEqual(
      expect.arrayContaining([
        '$pageview',
        'instant_import_connection_clicked',
        'instant_import_action_failed',
      ])
    )
})
