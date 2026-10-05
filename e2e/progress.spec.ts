import { expect, test } from '@playwright/test'

import { basePath } from '../src/base-path'
import { mockSupabaseConnection } from './oauth-fixtures'

test('shows live batches and stages without resetting during a continuation or failed poll', async ({
  page,
}) => {
  await mockSupabaseConnection(page)
  const jobId = '00000000-0000-4000-8000-000000000001'
  let phase: string | null = 'rows'
  let revision: string | null = '101'
  let fail = false
  let retrying = false
  await page.route(`**/api/browser-imports/${jobId}`, (route) =>
    route.fulfill(
      fail
        ? { status: 503, json: { error: 'Progress is temporarily unavailable' } }
        : {
            json: {
              jobId,
              status: 'running',
              phase,
              revision,
              retrying,
              attempt: retrying ? 2 : 1,
              startedAt: null,
              cancelRequested: false,
              uploadedFiles: 44,
              totalFiles: 44,
              artifacts: [],
            },
          }
    )
  )
  await page.goto(`${basePath}?job=${jobId}`)
  await expect(page.getByText('100 batches completed.', { exact: false })).toBeVisible()
  const records = page.getByRole('listitem').filter({ hasText: 'Import records' })
  await expect(records).toContainText('In progress')
  revision = '151'
  await expect(page.getByText('150 batches completed.', { exact: false })).toBeVisible()
  phase = null
  revision = null
  retrying = true
  await expect(page.getByText('Retrying · attempt 2')).toBeVisible()
  await expect(records).toContainText('In progress')
  await expect(page.getByText('150 batches completed.', { exact: false })).toBeVisible()
  fail = true
  await expect(page.getByText('Progress is temporarily unavailable')).toBeVisible()
  await expect(page.getByText('150 batches completed.', { exact: false })).toBeVisible()
  fail = false
  retrying = false
  phase = 'links'
  revision = '202'
  await expect(page.getByText('201 batches completed.', { exact: false })).toBeVisible()
  await expect(records).toContainText('Complete')
  await expect(
    page.getByRole('listitem').filter({ hasText: 'Connect relationships' })
  ).toContainText('In progress')
  await expect(page.getByText('Progress is temporarily unavailable')).toHaveCount(0)
})
