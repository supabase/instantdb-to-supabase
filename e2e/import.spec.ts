import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from '@playwright/test'

import { fullEntries } from '../tests/fixtures'
import { databaseUrl, mockSupabaseConnection, projectRef } from './oauth-fixtures'

test('guides users to create a blank project and refreshes the picker afterward', async ({
  page,
}) => {
  let requests = 0
  await page.route('**/api/supabase/connection', (route) => {
    requests++
    return route.fulfill({
      json: {
        ready: true,
        configured: true,
        connected: true,
        projects:
          requests === 1
            ? []
            : [
                {
                  ref: projectRef,
                  name: 'New blank project',
                  status: 'ACTIVE_HEALTHY',
                  region: 'test',
                },
              ],
      },
    })
  })
  await page.goto('/')
  await expect(page.getByText('Use a new, empty Supabase project.', { exact: false })).toBeVisible()
  const create = page.getByRole('link', { name: 'Create a new project', exact: true })
  await expect(create).toHaveAttribute('href', 'https://supabase.com/dashboard/new/_')
  await expect(create).toHaveAttribute('target', '_blank')
  await expect(page.getByText('No projects are available.', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Refresh projects', exact: true }).click()
  await expect(page.getByText('No projects are available.', { exact: false })).toHaveCount(0)
  await page.getByRole('combobox', { name: 'Project', exact: true }).click()
  await page.getByRole('option', { name: /^New blank project/ }).click()
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toContainText(
    'New blank project'
  )
  expect(requests).toBe(2)
})

test('prerenders the landing page without waiting for JavaScript or a connection', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false })
  try {
    const page = await context.newPage()
    await page.goto(baseURL!)
    await expect(
      page.getByRole('heading', { name: 'Migrate from InstantDB to Supabase.' })
    ).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Your migration in three steps' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Connect Supabase', exact: true })).toBeDisabled()
    await expect(page.getByText('Imports are not available on this deployment')).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test('checks deployment readiness at request time without caching the connection', async ({
  request,
}) => {
  const response = await request.get('/api/supabase/connection')
  expect(response.status()).toBe(200)
  expect(response.headers()['cache-control']).toBe('no-store')
  expect(await response.json()).toMatchObject({ ready: true, connected: false, projects: [] })
})

test('requires Connect Supabase and has no raw credential fallback', async ({ page }) => {
  await mockSupabaseConnection(page, false)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Connect Supabase', exact: true })).toBeVisible()
  await expect(page.getByLabel('Backup folder', { exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Project URL', { exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Secret key', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /manual/i })).toHaveCount(0)
})

test('shows a configuration state instead of falling back to raw credentials', async ({ page }) => {
  await mockSupabaseConnection(page, false, false)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Connect Supabase', exact: true })).toBeDisabled()
  await expect(
    page.getByText(/Supabase OAuth is not configured for this deployment\./)
  ).toBeVisible()
  await expect(page.getByLabel('Postgres connection string', { exact: true })).toHaveCount(0)
})

test('submits only the authorized project reference without credentials', async ({ page }) => {
  // UI contract coverage; provider authorization and the import worker have separate suites.
  await mockSupabaseConnection(page)
  const folder = await mkdtemp(join(tmpdir(), 'instant-oauth-browser-'))
  try {
    for (const [path, bytes] of fullEntries()) {
      await mkdir(dirname(join(folder, path)), { recursive: true })
      await writeFile(join(folder, path), bytes)
    }
    await page.route('**/api/browser-imports', (route) =>
      route.fulfill({ status: 409, json: { error: 'Destination is not blank' } })
    )
    await page.goto('/')
    await page.getByLabel('Backup folder', { exact: true }).setInputFiles(folder)
    await page.getByRole('combobox', { name: 'Project', exact: true }).click()
    await page
      .getByRole('option', { name: new RegExp(`^Import destination.*${projectRef}`) })
      .click()
    await expect(page.getByLabel('Postgres connection string', { exact: true })).toHaveCount(0)
    const sent = page.waitForRequest(
      (request) =>
        request.method() === 'POST' && new URL(request.url()).pathname === '/api/browser-imports'
    )
    await page.getByRole('button', { name: 'Start import', exact: true }).click()
    expect((await sent).postDataJSON().target).toEqual({ mode: 'oauth', projectRef })
    await expect(
      page.getByRole('alert').filter({ hasText: 'Destination is not blank' })
    ).toBeVisible()
    await expect(page.getByLabel('Project URL', { exact: true })).toHaveCount(0)
    await expect(page.getByLabel('Secret key', { exact: true })).toHaveCount(0)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('rejects manual credential payloads at the browser API boundary', async ({
  request,
  baseURL,
}) => {
  const response = await request.post('/api/browser-imports', {
    headers: { Origin: new URL(baseURL!).origin },
    data: {
      target: {
        databaseUrl,
        supabaseUrl: `https://${projectRef}.supabase.co`,
        serviceRoleKey: 'client-supplied-secret',
      },
      fileCount: 1,
      selectionHash: '0'.repeat(64),
    },
  })
  expect(response.status()).toBe(400)
  expect(await response.text()).not.toContain('client-supplied-secret')
})
