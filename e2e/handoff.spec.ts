import { expect, test } from '@playwright/test'

import { basePath } from '../src/base-path'
import type { Handoff } from '../src/import/handoff'
import { mockSupabaseConnection, projectRef } from './oauth-fixtures'

const jobId = '00000000-0000-4000-8000-000000000001'
const handoff: Handoff = {
  jobId,
  projectRef,
  permissionsApplied: true,
  allowed: 1,
  denied: 1,
  summary: { converted: 2, manual: 1, excluded: 0 },
  convertedRules: [
    {
      id: 'rule-0',
      title: 'people · view',
      target: 'public.people',
      effect: 'allow',
      policyName: 'import_view',
    },
    {
      id: 'rule-2',
      title: 'people · create',
      target: 'public.people',
      effect: 'deny',
      policyName: null,
    },
  ],
  verified: { namespaces: 1, rows: 2, edges: 0, files: 0, bytes: 0 },
  links: [
    { label: 'Open tables', href: `https://supabase.com/dashboard/project/${projectRef}/editor` },
    {
      label: 'Open migrations',
      href: `https://supabase.com/dashboard/project/${projectRef}/database/migrations`,
    },
    {
      label: 'Open RLS policies',
      href: `https://supabase.com/dashboard/project/${projectRef}/database/policies`,
    },
  ],
  commands: `supabase login\nsupabase link --project-ref ${projectRef}\nsupabase migration fetch --linked`,
  items: [
    { id: 'rule-1', kind: 'policy', title: 'people · update', reason: 'Needs old/new semantics' },
    {
      id: 'application',
      kind: 'setup',
      title: 'Connect your application',
      reason: 'Your application still calls InstantDB.',
    },
  ],
}
test.beforeEach(async ({ page }) => {
  await mockSupabaseConnection(page)
  await page.route(`**/api/browser-imports/${jobId}`, (route) =>
    route.fulfill({
      json: {
        jobId,
        status: 'completed',
        phase: 'completed',
        revision: '100',
        retrying: false,
        attempt: 1,
        startedAt: null,
        cancelRequested: false,
        uploadedFiles: 1,
        totalFiles: 1,
        artifacts: [],
      },
    })
  )
  await page.route(`**/api/browser-imports/${jobId}/handoff`, (route) =>
    route.fulfill({ json: handoff })
  )
})
for (const deleted of [false, true]) {
  test(`confirms backup deletion only for cleaned imports: ${deleted}`, async ({ page }) => {
    await page.route(`**/api/browser-imports/${jobId}/handoff`, (route) =>
      route.fulfill({ json: { ...handoff, backupDeleted: deleted } })
    )
    await page.goto(`${basePath}?job=${jobId}`)
    await expect(
      page.getByText('Every record and link was verified', { exact: false })
    ).toBeVisible()
    const confirmation = page.getByText(
      'The uploaded backup and staged records have been deleted',
      { exact: false }
    )
    if (deleted) await expect(confirmation).toBeVisible()
    else await expect(confirmation).toHaveCount(0)
  })
}
test('shows converted policy warnings and provides a review prompt', async ({ page }) => {
  const warning = 'Check anonymous access for nullable ownership values.'
  const review = {
    id: 'rule-0',
    kind: 'policy' as const,
    title: 'Review people · view',
    reason: warning,
  }
  await page.route(`**/api/browser-imports/${jobId}/handoff`, (route) =>
    route.fulfill({
      json: {
        ...handoff,
        convertedRules: handoff.convertedRules.map((rule) =>
          rule.id === review.id ? { ...rule, review: warning } : rule
        ),
        items: [...handoff.items, review],
      },
    })
  )
  await page.route(`**/api/browser-imports/${jobId}/handoff?rule=rule-0`, (route) =>
    route.fulfill({
      json: {
        source: 'people.allow.view',
        expression: 'data.owner == auth.id',
        bindings: {},
        sql: null,
        suggestion: 'Confirm whether a signed-in user is required.',
      },
    })
  )
  await page.route(`**/api/browser-imports/${jobId}/handoff?item=rule-0`, (route) =>
    route.fulfill({
      json: {
        prompt: 'Review the already converted rule in a new local migration.',
      },
    })
  )
  await page.goto(`${basePath}?job=${jobId}`)
  await page.getByText('Applied access policies · 1', { exact: true }).click()
  await expect(page.getByText('Applied · review access below', { exact: true })).toBeVisible()
  await page.getByText('people · view', { exact: true }).click()
  await expect(page.getByText('Confirm whether a signed-in user is required.')).toBeVisible()
  await page.locator('summary').filter({ hasText: 'Policies and relationships' }).click()
  await page.getByText('Review people · view', { exact: true }).click()
  await expect(page.getByText(warning, { exact: true })).toBeVisible()
  await expect(
    page.getByText('Review the already converted rule in a new local migration.', { exact: true })
  ).toBeVisible()
})
test('explains remaining work and shows applied policies separately from preserved denials', async ({
  page,
}) => {
  let requests = 0
  await page.route(`**/api/browser-imports/${jobId}/handoff?rule=*`, (route) => {
    requests++
    return route.fulfill({
      json: { expression: 'false', source: '$default.allow.$default', bindings: {} },
    })
  })
  await page.goto(`${basePath}?job=${jobId}`)
  await expect(page.getByRole('heading', { name: 'Imported automatically' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Still needs your attention' })).toBeVisible()
  await expect(page.getByText(/No access was granted for unconverted operations/)).toBeVisible()
  const groups = page
    .locator('summary')
    .filter({ hasText: /^(Application setup|Policies and relationships)/ })
  expect(await groups.allTextContents()).toEqual([
    expect.stringContaining('Application setup'),
    expect.stringContaining('Policies and relationships'),
  ])
  await page.getByText('Applied access policies · 1', { exact: true }).click()
  await expect(page.getByText('people · view', { exact: true })).toBeVisible()
  expect(requests).toBe(0)
  await page.getByText('Preserved deny rules · 1', { exact: true }).click()
  await page.getByText('people · create', { exact: true }).click()
  await expect(page.getByLabel('Source rule for people · create')).toHaveText('false')
  await expect(page.getByText(/does not appear as a separate policy in Studio/)).toBeVisible()
  expect(requests).toBe(1)
})
test('does not call legacy unapplied rules imported policies', async ({ page }) => {
  await page.route(`**/api/browser-imports/${jobId}/handoff`, (route) =>
    route.fulfill({ json: { ...handoff, permissionsApplied: false } })
  )
  await page.goto(`${basePath}?job=${jobId}`)
  await expect(page.getByText(/This earlier import has unapplied security rules/)).toBeVisible()
  await expect(page.getByText('Applied access policies · 1', { exact: true })).toHaveCount(0)
})
test('compares the source rule with applied SQL and copies its supporting statements', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const sql = {
    policy: 'CREATE POLICY import_view ON public.people FOR SELECT USING (true);',
    supporting: 'GRANT SELECT ON public.people TO authenticated;',
    all: 'CREATE POLICY import_view ON public.people FOR SELECT USING (true);\n\nGRANT SELECT ON public.people TO authenticated;',
  }
  await page.route(`**/api/browser-imports/${jobId}/handoff?rule=*`, (route) =>
    route.fulfill({
      json: {
        expression: 'true',
        source: 'people.allow.view',
        bindings: {},
        sql,
      },
    })
  )
  await page.goto(`${basePath}?job=${jobId}`)
  await page.getByText('Applied access policies · 1', { exact: true }).click()
  await page.getByText('people · view', { exact: true }).click()
  await expect(page.getByLabel('Source rule for people · view')).toHaveText('true')
  await expect(page.getByLabel('Applied SQL for people · view')).toHaveText(sql.policy)
  await expect(
    page.getByText('view becomes SELECT. USING decides which existing rows a user can read.')
  ).toBeVisible()
  await page.getByText('Table grants', { exact: true }).click()
  await expect(page.getByLabel('Supporting SQL for people · view')).toHaveText(sql.supporting)
  await page.getByRole('button', { name: 'Copy policy SQL' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(sql.all)
})
test('replaces completed progress and downloads with project links and CLI instructions', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto(`${basePath}?job=${jobId}`)
  await expect(page.getByRole('heading', { name: 'Import complete', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Import progress' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /download/i })).toHaveCount(0)
  for (const [index, label] of [
    'Table Editor',
    'Database migrations',
    'Database policies',
  ].entries())
    await expect(page.getByRole('link', { name: label, exact: true }).first()).toHaveAttribute(
      'href',
      handoff.links[index].href
    )
  await page.getByRole('button', { name: 'Copy CLI commands' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(handoff.commands)
  await expect(page.getByText('supabase init', { exact: true })).toBeVisible()
})
test('loads prompts on demand and copies the full context', async ({ page, context }) => {
  const events: { action: string; properties: Record<string, unknown> }[] = []
  await page.route('**/api/telemetry', (route) => {
    events.push(route.request().postDataJSON())
    return route.fulfill({ status: 204 })
  })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  let requests = 0
  const prompt =
    'Run this prompt in your local project directory.\nOriginal rule and mappings: <script>untrusted</script>'
  await page.route(`**/api/browser-imports/${jobId}/handoff?item=*`, (route) => {
    requests++
    return route.fulfill({ json: { prompt } })
  })
  await page.goto(`${basePath}?job=${jobId}`)
  const item = handoff.items[0]
  await page.getByText('Policies and relationships · 1', { exact: true }).click()
  await expect(page.getByText(item.title, { exact: true })).toBeVisible()
  expect(requests).toBe(0)
  await page.getByText(item.title, { exact: true }).click()
  await expect(page.getByLabel(`Agent prompt for ${item.title}`)).toHaveText(prompt)
  await page.getByRole('button', { name: 'Copy agent prompt' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(prompt)
  expect(requests).toBe(1)
  await expect
    .poll(() => events.map((event) => event.action))
    .toContain('instant_import_handoff_copied')
  expect(events).toContainEqual({
    action: 'instant_import_handoff_opened',
    properties: { handoffType: 'policy' },
  })
  expect(events).toContainEqual({
    action: 'instant_import_handoff_copied',
    properties: { handoffType: 'policy' },
  })
  expect(JSON.stringify(events)).not.toMatch(/untrusted|Original rule|people|project directory/)
})
test('lets the user recover from a prompt failure', async ({ page }) => {
  let attempts = 0
  await page.route(`**/api/browser-imports/${jobId}/handoff?item=*`, (route) =>
    route.fulfill(
      ++attempts === 1
        ? { status: 503, json: { error: 'Unavailable' } }
        : { json: { prompt: 'Recovered prompt' } }
    )
  )
  await page.goto(`${basePath}?job=${jobId}`)
  await page.getByText('Policies and relationships · 1', { exact: true }).click()
  await page.getByText(handoff.items[0].title, { exact: true }).click()
  await page.getByRole('button', { name: 'Retry prompt' }).click()
  await expect(page.getByText('Recovered prompt', { exact: true })).toBeVisible()
})
