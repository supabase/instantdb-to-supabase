import { expect, test } from '@playwright/test'
import { Client } from 'pg'

import { basePath } from '../src/base-path'
import { mockSupabaseConnection } from './oauth-fixtures'

// Reads the service project the server under test writes to. CI exports it for both processes.
const url = process.env.IMPORT_JOB_DATABASE_URL
if (url && !['localhost', '127.0.0.1'].includes(new URL(url).hostname))
  throw new Error('Usage log browser tests require a local service database')

test.skip(!url, 'Requires IMPORT_JOB_DATABASE_URL for a local service project')

test('records browser events in the usage log when privacy signals turn PostHog off', async ({
  page,
}) => {
  const db = new Client({ connectionString: url })
  await db.connect()
  try {
    const since = (await db.query('SELECT now() AS at')).rows[0].at
    await page.setExtraHTTPHeaders({ DNT: '1', 'Sec-GPC': '1' })
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'globalPrivacyControl', { value: true })
      Object.defineProperty(navigator, 'doNotTrack', { value: '1' })
    })
    // PostHog honors the privacy signals; the Server Action posts to the page itself.
    let posthogRequests = 0
    await page.route('https://ph.supabase.com/**', (route) => {
      posthogRequests++
      return route.abort('blockedbyclient')
    })
    await mockSupabaseConnection(page, false)
    await page.route('**/api/supabase/connect', (route) =>
      route.fulfill({ status: 400, json: { error: 'Connection refused' } })
    )
    await page.goto(basePath)
    await page.getByRole('button', { name: 'Connect Supabase', exact: true }).click()
    await expect(page.getByText('Connection refused')).toBeVisible()
    const rows = async () =>
      (
        await db.query(
          'SELECT event,job_id,target_ref,environment,properties FROM public.usage_events WHERE occurred_at>=$1 AND job_id IS NULL ORDER BY occurred_at',
          [since]
        )
      ).rows
    await expect
      .poll(async () => (await rows()).map((row) => row.event))
      .toEqual(
        expect.arrayContaining([
          '$pageview',
          'instant_import_connection_clicked',
          'instant_import_action_failed',
        ])
      )
    expect(posthogRequests).toBe(0)
    const recorded = await rows()
    expect(recorded).toContainEqual({
      event: 'instant_import_connection_clicked',
      job_id: null,
      target_ref: null,
      environment: 'development',
      properties: { connectionAction: 'connect' },
    })
    expect(recorded).toContainEqual({
      event: '$pageview',
      job_id: null,
      target_ref: null,
      environment: 'development',
      properties: {},
    })
    expect(JSON.stringify(recorded)).not.toMatch(/Connection refused|127\.0\.0\.1|localhost|http/)
  } finally {
    await db.end()
  }
})
