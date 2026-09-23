import type { Page } from '@playwright/test'

export const projectRef = 'abcdefghijklmnopqrst'
export const databaseUrl = `postgresql://postgres:password@db.${projectRef}.supabase.co:5432/postgres`
export async function mockSupabaseConnection(page: Page, connected = true, configured = true) {
  await page.route('**/api/supabase/connection', (route) =>
    route.fulfill({
      json: {
        ready: true,
        configured,
        connected,
        projects: connected
          ? [
              {
                ref: projectRef,
                name: 'Import destination',
                status: 'ACTIVE_HEALTHY',
                region: 'local-test',
              },
            ]
          : [],
      },
    })
  )
}
