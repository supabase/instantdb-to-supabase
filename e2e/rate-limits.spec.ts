import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from '@playwright/test'

import { basePath } from '../src/base-path'
import { fullEntries } from '../tests/fixtures'
import { mockSupabaseConnection, projectRef } from './oauth-fixtures'

test('waits for the rate-limit deadline and loads projects without reconnecting', async ({
  page,
}) => {
  await page.clock.install()
  let calls = 0
  await page.route('**/api/supabase/connection', async (route) => {
    calls++
    if (calls === 1)
      return route.fulfill({
        status: 429,
        headers: { 'Retry-After': '3' },
        json: { error: 'Rate limited', retryAt: Date.now() + 3000 },
      })
    return route.fulfill({
      json: {
        ready: true,
        configured: true,
        connected: true,
        projects: [
          { ref: projectRef, name: 'Import destination', status: 'ACTIVE_HEALTHY', region: 'test' },
        ],
      },
    })
  })
  await page.goto(basePath)
  await expect(page.getByRole('status')).toContainText('Waiting for Supabase. Retrying at')
  await page.clock.fastForward(1000)
  expect(calls).toBe(1)
  await page.clock.fastForward(5000)
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toBeVisible()
  await expect(page.getByText('Waiting for Supabase.', { exact: false })).toHaveCount(0)
  expect(calls).toBe(2)
})

test('retries throttled import preparation with the original selection', async ({ page }) => {
  await mockSupabaseConnection(page)
  await page.clock.install()
  const folder = await mkdtemp(join(tmpdir(), 'instant-rate-browser-'))
  const submissions: unknown[] = []
  try {
    for (const [path, bytes] of fullEntries()) {
      await mkdir(dirname(join(folder, path)), { recursive: true })
      await writeFile(join(folder, path), bytes)
    }
    await page.route('**/api/browser-imports', (route) => {
      submissions.push(route.request().postDataJSON())
      return submissions.length === 1
        ? route.fulfill({
            status: 429,
            headers: { 'Retry-After': '3' },
            json: { error: 'Rate limited', retryAt: Date.now() + 3000 },
          })
        : route.fulfill({ status: 409, json: { error: 'Destination is not blank' } })
    })
    await page.goto(basePath)
    await page.getByLabel('Backup folder', { exact: true }).setInputFiles(folder)
    await page.getByRole('combobox', { name: 'Project', exact: true }).click()
    await page
      .getByRole('option', { name: new RegExp(`^Import destination.*${projectRef}`) })
      .click()
    await page.getByRole('button', { name: 'Start import', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('Waiting for Supabase. Retrying at')
    await page.clock.fastForward(1000)
    expect(submissions).toHaveLength(1)
    await page.clock.fastForward(5000)
    await expect(page.getByRole('main').getByRole('alert', { name: 'Danger' })).toContainText(
      'Destination is not blank'
    )
    expect(submissions).toHaveLength(2)
    expect(submissions[1]).toEqual(submissions[0])
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('offers a connection retry after an API failure without showing missing configuration', async ({
  page,
}) => {
  let calls = 0
  await page.route('**/api/supabase/connection', (route) => {
    calls++
    return calls === 1
      ? route.fulfill({ status: 503, json: { error: 'Supabase is temporarily unavailable' } })
      : route.fulfill({
          json: {
            ready: true,
            configured: true,
            connected: true,
            projects: [
              {
                ref: projectRef,
                name: 'Import destination',
                status: 'ACTIVE_HEALTHY',
                region: 'test',
              },
            ],
          },
        })
  })
  await page.goto(basePath)
  await expect(page.getByRole('main').getByRole('alert', { name: 'Danger' })).toContainText(
    'Supabase is temporarily unavailable'
  )
  await expect(
    page.getByText(/Supabase OAuth is not configured for this deployment\./)
  ).toHaveCount(0)
  await page.getByRole('button', { name: 'Retry connection', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toBeVisible()
  expect(calls).toBe(2)
})
