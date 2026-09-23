import { expect, test } from '@playwright/test'

import { mockSupabaseConnection, projectRef } from './oauth-fixtures'

test.beforeEach(async ({ page }) => {
  await mockSupabaseConnection(page)
})

test('switches and persists Studio themes without clearing project selection', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  await expect(page).toHaveTitle('InstantDB to Supabase Migration')
  await expect(
    page.getByRole('link', { name: 'InstantDB to Supabase migration home' })
  ).toBeVisible()
  await expect(page.locator('html')).toHaveClass(/light/)
  await page.getByRole('combobox', { name: 'Project', exact: true }).click()
  await page.getByRole('option', { name: new RegExp(`^Import destination.*${projectRef}`) }).click()
  await page.getByRole('button', { name: 'Toggle theme' }).click()
  await page.getByRole('menuitemradio', { name: 'Dark', exact: true }).click()
  await expect(page.getByRole('menu')).toBeHidden()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toContainText(
    'Import destination'
  )
  await expect(page.getByLabel('Postgres connection string', { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.getByRole('button', { name: 'Toggle theme' }).click()
  await expect(page.getByRole('menuitemradio', { name: 'Dark', exact: true })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await page.getByRole('menuitemradio', { name: 'System', exact: true }).click()
  await expect(page.getByRole('menu')).toBeHidden()
  await expect(page.locator('html')).toHaveClass(/light/)
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.getByRole('button', { name: 'Toggle theme' }).click()
  await page.getByRole('menuitemradio', { name: 'Light', exact: true }).click()
  await expect(page.locator('html')).toHaveClass(/light/)
  expect(errors).toEqual([])
})

for (const colorScheme of ['light', 'dark'] as const) {
  test(`renders the form on mobile in ${colorScheme} mode`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme })
    await page.goto('/')
    await expect(
      page.getByRole('heading', { name: 'Migrate from InstantDB to Supabase.' })
    ).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toBeVisible()
    await expect(page.getByLabel('Postgres connection string', { exact: true })).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole('button', { name: 'Toggle theme' }).click()
    await expect(page.getByRole('menuitemradio', { name: 'System', exact: true })).toBeVisible()
  })
}
