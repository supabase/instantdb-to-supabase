import { describe, expect, it } from 'vitest'

import { buildHandoff, handoffPrompt, handoffRule } from '../src/import/handoff'
import { compilePermissions, permissionsSql } from '../src/import/permissions'
import { analyze } from '../src/import/plan'
import { entries, fullEntries } from './fixtures'

const projectRef = 'abcdefghijklmnopqrst'
const jobId = '00000000-0000-4000-8000-000000000001'
function fixture() {
  const input = fullEntries()
  const config = JSON.parse(input.get('config.json')!.toString())
  config.rules = {
    $default: { allow: { $default: 'false' } },
    empty: { allow: { view: 'true' } },
    people: {
      bind: { owner: 'auth.id == data.id' },
      allow: { view: 'true', update: 'owner && newData.name == data.name' },
      fields: { optional: 'owner' },
    },
  }
  config.schema.links.owner = {
    forward: { on: 'empty', label: 'owner', has: 'one' },
    reverse: { on: 'people', label: 'owned', has: 'many' },
  }
  config.webhooks = [{ url: 'https://example.com/hook?token=private-secret', secret: 'secret' }]
  input.set('config.json', Buffer.from(JSON.stringify(config)))
  return analyze(input)
}
describe('guided import handoff', () => {
  it.each(['data.optional == auth.id', undefined])(
    'exposes review warnings and a scoped prompt for converted rules: %s',
    (expression) => {
      const input = entries()
      const config = JSON.parse(input.get('config.json')!.toString())
      config.rules = expression
        ? { people: { allow: { view: expression, $default: 'false' } } }
        : {}
      input.set('config.json', Buffer.from(JSON.stringify(config)))
      const plan = analyze(input)
      const handoff = buildHandoff(plan, { projectRef, jobId, permissionsApplied: true })
      const rule = handoff.convertedRules.find((r) => r.title === 'people · view')!
      expect(rule).toHaveProperty('review', expect.any(String))
      expect(handoff.items.find((item) => item.id === rule.id)?.title).toBe('Review people · view')
      expect(handoffRule(plan, rule.id)).toHaveProperty('suggestion', expect.any(String))
      const prompt = handoffPrompt(plan, handoff, rule.id)
      expect(prompt).toContain('already converted')
      expect(prompt).toContain('local')
      expect(prompt).toContain('migration')
      expect(prompt).toContain(expression ?? 'implicit default')
    }
  )
  it('provides a focused task for unsupported uniqueness without references to removed staging tables', () => {
    const plan = fixture(),
      ns = plan.namespaces.find((n) => n.source === 'people')!
    const column = ns.columns[0]
    column.unique = true
    column.indexMethod = 'hash'
    const result = buildHandoff(plan, { projectRef, jobId, permissionsApplied: true })
    const item = result.items.find((i) => i.id.startsWith('constraint-'))!
    expect(item.title).toContain(column.target)
    const prompt = handoffPrompt(plan, result, item.id)
    expect(prompt).toContain('sourceUnique')
    expect(prompt).toContain(column.target)
    expect(prompt).not.toContain('instant_workflow_')
    expect(handoffPrompt(plan, result, 'application')).not.toContain('.file_registry')
  })
  it('shows the exact applied policy, helper, and grants for only the selected rule', () => {
    const plan = fixture(),
      report = compilePermissions(plan)
    const handoff = buildHandoff(plan, { projectRef, jobId, permissionsApplied: true })
    const rule = handoff.convertedRules.find((r) => r.title === 'empty · view')!
    const detail = handoffRule(plan, rule.id, permissionsSql(report))
    expect(detail.sql?.policy).toContain('CREATE POLICY import_view ON public.empty FOR SELECT')
    expect(detail.sql?.all).not.toMatch(/CREATE FUNCTION|CREATE SCHEMA/)
    expect(detail.sql?.supporting).toContain('GRANT SELECT')
    expect(detail.sql?.supporting).not.toContain('CREATE POLICY')
    expect(detail.sql?.all).not.toContain('public.people')
    for (const statement of report.ruleStatements[rule.id])
      expect(permissionsSql(report)).toContain(`${statement};`)
    expect(detail.sql?.all).toBe(report.ruleStatements[rule.id].map((s) => `${s};`).join('\n\n'))
  })
  it('never labels regenerated or missing historical SQL as applied', () => {
    const plan = fixture(),
      report = compilePermissions(plan)
    const handoff = buildHandoff(plan, { projectRef, jobId, permissionsApplied: true })
    const rule = handoff.convertedRules.find((r) => r.effect === 'allow')!
    expect(handoffRule(plan, rule.id).sql).toBeNull()
    expect(
      handoffRule(plan, rule.id, permissionsSql(report).replace('CREATE POLICY', 'ALTER POLICY'))
        .sql
    ).toBeNull()
  })
  it('does not invent SQL for an explicit deny', () => {
    const plan = fixture(),
      report = compilePermissions(plan)
    const handoff = buildHandoff(plan, { projectRef, jobId, permissionsApplied: true })
    const rule = handoff.convertedRules.find((r) => r.effect === 'deny')!
    expect(handoffRule(plan, rule.id, permissionsSql(report)).sql).toBeNull()
  })
  it.each([
    ['view', 'SELECT', 'USING'],
    ['create', 'INSERT', 'WITH CHECK'],
    ['update', 'UPDATE', 'WITH CHECK'],
    ['delete', 'DELETE', 'USING'],
  ])('maps %s to its own %s policy without mixing operations', (action, command, clause) => {
    const plan = fixture(),
      config = JSON.parse(plan.config.toString())
    config.rules.people = { allow: { $default: 'true' } }
    plan.config = Buffer.from(JSON.stringify(config))
    plan.links = []
    const report = compilePermissions(plan)
    const handoff = buildHandoff(plan, { projectRef, jobId, permissionsApplied: true })
    const rule = handoff.convertedRules.find((r) => r.title === `people · ${action}`)!
    const detail = handoffRule(plan, rule.id, permissionsSql(report))
    expect(detail.sql?.policy).toContain(
      `CREATE POLICY import_${action} ON public.people FOR ${command}`
    )
    expect(detail.sql?.policy).toContain(clause)
    expect(detail.sql?.supporting).toContain(`GRANT ${command}`)
    expect(detail.sql?.all.match(/CREATE POLICY /g)).toHaveLength(1)
  })
  it('lists only converted rules and distinguishes policies from preserved denials', () => {
    const plan = fixture()
    const result = buildHandoff(plan, { projectRef, jobId, permissionsApplied: true })
    expect(result.convertedRules).toHaveLength(result.summary.converted)
    expect(result.convertedRules.filter((r) => r.effect === 'allow')).toHaveLength(result.allowed)
    expect(result.convertedRules.filter((r) => r.effect === 'deny')).toHaveLength(result.denied)
    expect(result.convertedRules.find((r) => r.title === 'empty · view')).toMatchObject({
      target: 'public.empty',
      effect: 'allow',
      policyName: 'import_view',
    })
    expect(result.convertedRules.find((r) => r.title === 'empty · create')).toMatchObject({
      effect: 'deny',
      policyName: null,
    })
    expect(result.convertedRules.some((r) => r.title === 'people · update')).toBe(false)
    expect(JSON.stringify(result.convertedRules)).not.toContain('expression')
  })
  it('loads one converted rule with its source and only its own binding dependencies', () => {
    const plan = fixture(),
      config = JSON.parse(plan.config.toString())
    config.rules.empty = {
      bind: { allowed: 'true', unused: 'private-unrelated' },
      allow: { view: 'allowed' },
    }
    plan.config = Buffer.from(JSON.stringify(config))
    const result = buildHandoff(plan, { projectRef, jobId, permissionsApplied: true })
    const rule = handoffRule(
      plan,
      result.convertedRules.find((r) => r.title === 'empty · view')!.id
    )
    expect(rule).toMatchObject({ expression: 'allowed', source: 'empty.allow.view' })
    expect(JSON.stringify(rule.bindings)).toContain('allowed')
    expect(JSON.stringify(rule)).not.toContain('private-unrelated')
    expect(JSON.stringify(rule)).not.toContain('newData.name')
  })
  it('retains default provenance for a deny without inventing a policy', () => {
    const plan = fixture()
    const result = buildHandoff(plan, { projectRef, jobId, permissionsApplied: true })
    const item = result.convertedRules.find((r) => r.title === 'empty · create')!
    expect(handoffRule(plan, item.id)).toMatchObject({
      expression: 'false',
      source: '$default.allow.$default',
    })
    expect(item.policyName).toBeNull()
  })
  it('does not present legacy generated rules as applied', () => {
    const result = buildHandoff(fixture(), { projectRef, jobId, permissionsApplied: false })
    expect(result.permissionsApplied).toBe(false)
    expect(result.convertedRules.length).toBeGreaterThan(0)
    expect(result.items.some((i) => i.id === 'apply-security')).toBe(true)
  })
  it('rejects unknown, malformed, and manual rule detail requests', () => {
    const plan = fixture()
    const result = buildHandoff(plan, { projectRef, jobId, permissionsApplied: true })
    for (const id of [
      'rule-99999',
      'rule--1',
      'rule-01',
      'rule-0junk',
      'application',
      result.items.find((i) => i.kind === 'policy')!.id,
    ])
      expect(() => handoffRule(plan, id)).toThrow('Converted rule not found')
  })
  it('links to the exact destination and fetches recorded migrations without a download', () => {
    const result = buildHandoff(fixture(), { projectRef, jobId, permissionsApplied: true })
    expect(result.links).toContainEqual({
      label: 'Open tables',
      href: `https://supabase.com/dashboard/project/${projectRef}/editor`,
    })
    expect(result.links).toContainEqual({
      label: 'Open RLS policies',
      href: `https://supabase.com/dashboard/project/${projectRef}/database/policies`,
    })
    expect(result.links).toContainEqual({
      label: 'Open migrations',
      href: `https://supabase.com/dashboard/project/${projectRef}/database/migrations`,
    })
    expect(result.commands).toContain(`supabase link --project-ref ${projectRef}`)
    expect(result.commands).toContain('supabase migration fetch --linked')
    expect(result.commands).not.toContain('db pull')
    expect(result.commands).not.toContain('db reset')
  })
  it('gives every manual rule its own stable prompt, including fields and relationships', () => {
    const plan = fixture(),
      permissions = compilePermissions(plan)
    const result = buildHandoff(plan, { projectRef, jobId, permissionsApplied: true })
    expect(result.items.filter((i) => i.kind === 'policy')).toHaveLength(permissions.summary.manual)
    const item = result.items.find((i) => i.title === 'people · update')!
    const prompt = handoffPrompt(plan, result, item.id)
    for (const text of [
      'local project directory',
      'supabase migration new',
      'newData.name == data.name',
      'auth.id == data.id',
      'fields',
      'optional',
      'user_accounts',
      'auth.uid()',
      'anon',
      'authenticated',
      'do not apply',
      'untrusted',
    ])
      expect(prompt).toContain(text)
    expect(prompt).not.toContain(`instant-${jobId}`)
    expect(prompt).not.toContain('private-secret')
    expect(prompt).not.toContain('createdAt')
    expect(() => handoffPrompt(plan, result, 'missing')).toThrow()
    expect(result.items.map((i) => i.id)).toEqual(
      buildHandoff(plan, { projectRef, jobId, permissionsApplied: true }).items.map((i) => i.id)
    )
  })
  it('omits unrelated tables, rules, bindings, and native services from a policy prompt', () => {
    const plan = fixture()
    const config = JSON.parse(plan.config.toString())
    config.rules.people.bind.unused = 'unrelatedSecret'
    config.rules.empty.allow.view = 'unrelatedRule'
    plan.config = Buffer.from(JSON.stringify(config))
    const result = buildHandoff(plan, { projectRef, jobId, permissionsApplied: true })
    const prompt = handoffPrompt(
      plan,
      result,
      result.items.find((i) => i.title === 'people · update')!.id
    )
    expect(prompt).toContain('newData.name == data.name')
    expect(prompt).toContain('auth.id == data.id')
    expect(prompt).not.toContain('unrelatedSecret')
    expect(prompt).not.toContain('unrelatedRule')
    expect(prompt).not.toContain('storage.objects')
    expect(prompt).not.toContain('sourceSchema')
    expect(prompt.length).toBeLessThan(8000)
  })
  it('keeps transitive bindings and multi-hop reference mappings', () => {
    const plan = fixture(),
      config = JSON.parse(plan.config.toString())
    config.rules.people = {
      bind: { allowed: 'member', member: "auth.id in data.ref('owned.owner.id')" },
      allow: { update: 'allowed && newData.name == data.name' },
    }
    plan.config = Buffer.from(JSON.stringify(config))
    const result = buildHandoff(plan, { projectRef, jobId, permissionsApplied: true })
    const prompt = handoffPrompt(
      plan,
      result,
      result.items.find((i) => i.title === 'people · update')!.id
    )
    for (const text of ['member', 'owned.owner.id', 'foreign_key', 'empty'])
      expect(prompt).toContain(text)
    expect(prompt).not.toContain('"kind": "junction"')
  })
  it('includes both endpoints and their authorization for relationship prompts', () => {
    const plan = fixture(),
      result = buildHandoff(plan, { projectRef, jobId, permissionsApplied: true })
    const prompt = handoffPrompt(
      plan,
      result,
      result.items.find((i) => i.title === 'empty · link.owner')!.id
    )
    for (const text of ['people', 'empty', 'foreign_key', 'newData.name == data.name'])
      expect(prompt).toContain(text)
    expect(prompt).not.toContain('storage.objects')
  })
  it('gives configuration tasks only their own settings and instructions', () => {
    const plan = fixture(),
      result = buildHandoff(plan, { projectRef, jobId, permissionsApplied: true })
    const prompt = handoffPrompt(plan, result, 'webhooks')
    expect(prompt).toContain('example.com')
    for (const text of [
      'private-secret',
      'newData.name',
      'people',
      'sourceSchema',
      'SECURITY DEFINER',
    ])
      expect(prompt).not.toContain(text)
    expect(prompt.length).toBeLessThan(3000)
  })
  it('does not grow a policy prompt when unrelated schema is added', () => {
    const plan = fixture()
    const prompt = () => {
      const result = buildHandoff(plan, { projectRef, jobId, permissionsApplied: true })
      return handoffPrompt(
        plan,
        result,
        result.items.find((i) => i.title === 'people · update')!.id
      )
    }
    const before = prompt()
    for (let i = 0; i < 100; i++)
      plan.namespaces.push({
        source: `unrelated_${i}`,
        target: `unrelated_${i}`,
        destination: 'public',
        columns: [],
        rows: [],
      })
    expect(prompt()).toBe(before)
  })
  it.each(['auth.id in data.ref(path)', "auth.id in data['friends']"])(
    'retains connected mappings for a dynamic dependency: %s',
    (expression) => {
      const plan = fixture(),
        config = JSON.parse(plan.config.toString())
      config.rules.people = { allow: { view: expression } }
      plan.config = Buffer.from(JSON.stringify(config))
      const result = buildHandoff(plan, { projectRef, jobId, permissionsApplied: true })
      const prompt = handoffPrompt(
        plan,
        result,
        result.items.find((i) => i.title === 'people · view')!.id
      )
      expect(prompt).toContain('"kind": "junction"')
      expect(prompt).toContain('foreign_key')
      expect(prompt).not.toContain('storage.objects')
    }
  )
  it('retains global and local binding definitions without looping on cycles', () => {
    const plan = fixture(),
      config = JSON.parse(plan.config.toString())
    config.rules.$default.bind = { owner: 'fallback', fallback: 'owner' }
    plan.config = Buffer.from(JSON.stringify(config))
    const result = buildHandoff(plan, { projectRef, jobId, permissionsApplied: true })
    const prompt = handoffPrompt(
      plan,
      result,
      result.items.find((i) => i.title === 'people · update')!.id
    )
    expect(prompt).toContain('fallback')
    expect(prompt).toContain('auth.id == data.id')
    expect(prompt.length).toBeLessThan(8000)
  })
  it('keeps the overview small and excludes runtime work from the action list', () => {
    const result = buildHandoff(fixture(), { projectRef, jobId, permissionsApplied: true })
    expect(result.items.some((i) => i.kind === 'setup')).toBe(true)
    expect(result.items.some((i) => /realtime|stream/i.test(i.title))).toBe(false)
    expect(JSON.stringify(result)).not.toContain('newData.name')
    expect(JSON.stringify(result)).not.toContain('private-secret')
  })
  it('does not claim old imports applied policies and supplies a migration prompt', () => {
    const plan = fixture(),
      result = buildHandoff(plan, { projectRef, jobId, permissionsApplied: false })
    expect(result.permissionsApplied).toBe(false)
    expect(result.items.some((i) => i.id === 'apply-security')).toBe(true)
    expect(handoffPrompt(plan, result, 'apply-security')).toContain('CREATE POLICY')
  })
  it.each(['bad/ref', '$(touch /tmp/oops)', '', 'https://example.com'])(
    'rejects unsafe project references: %s',
    (ref) => {
      expect(() =>
        buildHandoff(fixture(), { projectRef: ref, jobId, permissionsApplied: true })
      ).toThrow()
    }
  )
})
