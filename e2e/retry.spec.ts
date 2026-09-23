import { expect, test } from '@playwright/test'

import { mockSupabaseConnection } from './oauth-fixtures'

test('resumes polling after a successful retry even when the first status request fails', async ({
  page,
}) => {
  const jobId = '00000000-0000-4000-8000-000000000001'
  await mockSupabaseConnection(page)
  let restarted = false
  let failedRead = false
  await page.route(`**/api/browser-imports/${jobId}/start`, (route) => {
    restarted = true
    return route.fulfill({ json: { jobId } })
  })
  await page.route(`**/api/browser-imports/${jobId}`, (route) => {
    if (restarted && !failedRead) {
      failedRead = true
      return route.fulfill({ status: 503, json: { error: 'Temporary status failure' } })
    }
    return route.fulfill({
      json: {
        jobId,
        status: restarted ? 'running' : 'failed',
        phase: 'rows',
        revision: '1',
        retrying: false,
        attempt: 1,
        startedAt: null,
        cancelRequested: false,
        uploadedFiles: 1,
        totalFiles: 1,
        artifacts: [],
      },
    })
  })
  await page.goto(`/?job=${jobId}`)
  await expect(page.getByRole('heading', { name: 'Import paused after an error' })).toBeVisible()
  await page.getByRole('button', { name: 'Retry import', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Import paused after an error' })).toHaveCount(0)
  expect(failedRead).toBe(true)
})
