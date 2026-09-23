import { describe, expect, it } from 'vitest'

import { compilePermissions, permissionsManual, permissionsSql } from '../src/import/permissions'
import { analyze } from '../src/import/plan'
import { entries, fullEntries } from './fixtures'

export function permissionInput(rules: unknown) {
  const input = entries(),
    config = JSON.parse(input.get('config.json')!.toString())
  config.rules = rules
  input.set('config.json', Buffer.from(JSON.stringify(config)))
  return input
}
const compile = (rules: unknown) => compilePermissions(analyze(permissionInput(rules)))
const rule = (report: ReturnType<typeof compile>, action: string) =>
  report.rules.find((r) => r.namespace === 'people' && r.action === action)!

describe('conservative permission conversion', () => {
  it('converts public read and explicit denial independently', () => {
    const result = compile({ people: { allow: { view: 'true', $default: 'false' } } })
    expect(rule(result, 'view').status).toBe('converted')
    expect(rule(result, 'delete').status).toBe('converted')
    expect(rule(result, 'delete').effect).toBe('deny')
    expect(result.statements.join('\n')).toContain('FOR SELECT')
  })
  it('resolves operation and namespace defaults and reports where the rule came from', () => {
    const result = compile({
      $default: { allow: { $default: 'false', view: 'auth.id != null' } },
      people: { allow: { create: 'true', $default: 'false' } },
    })
    expect(rule(result, 'view').expression).toBe('false')
    expect(rule(result, 'create').expression).toBe('true')
    expect(
      result.rules.find((r) => r.namespace === 'empty' && r.action === 'view')!.expression
    ).toBe('auth.id != null')
  })
  it.each([
    'auth.id != null',
    'data.active',
    'data.score >= 0 && data.score <= 5',
    "data.name in ['One', 'Two']",
    "data.optional == null || data.optional == 'visible'",
    "!(data.name == 'Hidden')",
  ])('converts the complete supported expression %s', (expression) => {
    expect(rule(compile({ people: { allow: { view: expression } } }), 'view').status).toBe(
      'converted'
    )
  })
  it('expands bindings structurally', () => {
    expect(
      rule(
        compile({
          people: {
            bind: { loggedIn: 'auth.id != null', allowed: 'loggedIn && data.active' },
            allow: { view: 'allowed' },
          },
        }),
        'view'
      ).status
    ).toBe('converted')
  })
  it.each([
    'true || rateLimit.messages.limit(auth.id)',
    "request.modifiedFields.all(f, f in ['name'])",
    "'token' in ruleParams",
    'newData.score == data.score',
    'data.unknown == true',
    'data.json == true',
    'data.name; DROP TABLE public.people; --',
  ])('keeps unsupported rules closed without partial conversion: %s', (expression) => {
    const item = rule(compile({ people: { allow: { view: expression } } }), 'view')
    expect(item.status).toBe('manual')
    expect(item.expression).toBe(expression)
    expect(item.reason).toBeTruthy()
    expect(item.suggestion).toBeTruthy()
  })
  it('does not expose a row when its field restrictions need manual conversion', () => {
    const result = compile({
      people: { allow: { view: 'true' }, fields: { optional: 'auth.id == data.id' } },
    })
    expect(rule(result, 'view').status).toBe('manual')
    expect(result.statements.join('\n')).not.toContain('GRANT SELECT ON TABLE public.people')
    expect(result.rules.some((r) => r.action === 'fields.optional' && r.status === 'manual')).toBe(
      true
    )
  })
  it('reports cyclic bindings, malformed rules, unknown operations, and unknown namespaces', () => {
    expect(
      rule(compile({ people: { bind: { a: 'b', b: 'a' }, allow: { view: 'a' } } }), 'view').status
    ).toBe('manual')
    for (const rules of [null, 'bad', { people: { allow: { view: 123 } } }])
      expect(rule(compile(rules), 'view').status).toBe('manual')
    const result = compile({
      people: { allow: { search: 'true' } },
      mystery: { allow: { view: 'true' } },
    })
    expect(result.rules.some((r) => r.namespace === 'mystery' && r.status === 'manual')).toBe(true)
    expect(result.rules.some((r) => r.action === 'search' && r.status === 'manual')).toBe(true)
  })
  it('flags that an identity comparison also matches rows with no owner', () => {
    const result = compile({
      people: { allow: { view: 'data.optional == auth.id', $default: 'false' } },
    })
    const view = rule(result, 'view')
    expect(view).toMatchObject({ status: 'converted', effect: 'allow' })
    expect(view.reason).toMatch(/anonymous/i)
    expect(view.suggestion).toBeTruthy()
    expect(permissionsManual(result)).toContain('Converted rules that need review')
    // A NOT NULL column cannot match a NULL identity, so it needs no warning.
    const required = rule(
      compile({ people: { allow: { view: 'data.name == auth.id', $default: 'false' } } }),
      'view'
    )
    expect(required.status).toBe('converted')
    expect(required.reason).toBeUndefined()
  })
  it('flags the anonymous access an empty rule set grants by default', () => {
    const result = compile({})
    const view = rule(result, 'view')
    expect(view).toMatchObject({ status: 'converted', source: 'implicit default (true)' })
    expect(view.reason).toMatch(/implicit default/i)
    expect(view.suggestion).toBeTruthy()
    expect(permissionsManual(result)).toContain('Converted rules that need review')
    // An explicit source rule is converted without the warning.
    expect(
      rule(compile({ $default: { allow: { $default: 'true' } } }), 'view').reason
    ).toBeUndefined()
  })
  it('leaves data-dependent updates for a controlled old/new-row implementation', () => {
    expect(
      rule(compile({ people: { allow: { update: 'auth.id == data.id' } } }), 'update').status
    ).toBe('manual')
  })
})

describe('permission conversion boundaries and report completeness', () => {
  it.each([
    '1',
    'null',
    "'text'",
    '!1',
    "'a' < 'b'",
    'data.active && 1',
    'data.score == true',
    'data.name in [true]',
    'data.name in [data.optional]',
    "data.ref('friends.id')",
    "'x' in data.ref('friends.id')",
    "auth.id in data.ref('missing.id')",
    "auth.id in data.ref('friends.optional')",
    "auth.id in data.ref('friends.score')",
    "auth.id in auth.ref('$user.id')",
    "'admin' in auth.ref('$user.roles.name')",
    'true constructor false',
    'true __proto__ false',
  ])('reports the unsupported expression %s', (expression) => {
    const result = compile({ people: { allow: { view: expression, $default: 'false' } } })
    expect(rule(result, 'view').status).toBe('manual')
    expect(result.statements.join('\n')).not.toContain('ON public.people FOR SELECT')
  })
  it('preserves the full source object and makes the manual checklist readable', () => {
    const source = {
      people: {
        allow: { view: 'request.time > data.date' },
        bind: { unused: 'false' },
        fields: { optional: 'false' },
      },
      unknown: { allow: { view: 'true' } },
    }
    const result = compile(source)
    expect(result.sourceRules).toEqual(source)
    expect(result.applied).toBe(false)
    expect(result.rules.find((r) => r.source === 'people.bind.unused')?.expression).toBe('false')
    expect(permissionsManual(result)).toContain('request.time > data.date')
    expect(permissionsManual(result)).toContain('Generated SQL has not been applied')
    expect(permissionsSql(result)).toMatch(/^BEGIN;/)
    expect(permissionsSql(result)).toMatch(/COMMIT;\n$/)
  })
  it('tracks overridden defaults even when no operation uses them', () => {
    const result = compile({
      $default: { allow: { $default: 'ruleParams.token' } },
      people: { allow: { $default: 'false' } },
      empty: { allow: { $default: 'false' } },
    })
    expect(result.rules.find((r) => r.source === '$default.allow.$default')).toMatchObject({
      status: 'excluded',
      expression: 'ruleParams.token',
    })
  })
  it.each([
    { people: { allow: [] } },
    { people: { bind: [] } },
    { people: null },
    { people: { customConstraint: 'false', allow: { view: 'true' } } },
    { $default: { allow: 'true' } },
    { $default: { bind: [] } },
    { $default: null },
    {
      $default: { bind: { access: 'false' }, allow: { view: 'access' } },
      people: { bind: { access: 'true' } },
    },
  ])('does not silently ignore malformed or ambiguous rule configuration', (source) => {
    expect(rule(compile(source), 'view').status).toBe('manual')
  })
  it('limits exponential binding expansion', () => {
    const bind: Record<string, string> = { a0: 'true' }
    for (let i = 1; i <= 15; i++) bind[`a${i}`] = `a${i - 1} && a${i - 1}`
    expect(rule(compile({ people: { bind, allow: { view: 'a15' } } }), 'view')).toMatchObject({
      status: 'manual',
      reason: 'Expanded rule is too complex',
    })
  })
  it('does not compile reference-dependent creates from an existing graph', () => {
    expect(
      rule(
        compile({ people: { allow: { create: "auth.id in data.ref('friends.id')" } } }),
        'create'
      ).status
    ).toBe('manual')
  })
  it('does not emit functions or grants for an all-deny source', () => {
    const result = compile({ $default: { allow: { $default: 'false' } } })
    expect(result.statements).toEqual([])
    expect(
      result.rules.filter((r) => r.status === 'converted').every((r) => r.effect === 'deny')
    ).toBe(true)
  })
})

it('never claims native Auth denials are enforced by application RLS', () => {
  const input = fullEntries(),
    config = JSON.parse(input.get('config.json')!.toString())
  config.rules = { $default: { allow: { $default: 'false' } } }
  input.set('config.json', Buffer.from(JSON.stringify(config)))
  const result = compilePermissions(analyze(input))
  expect(result.rules.find((r) => r.namespace === '$users' && r.action === 'create')).toMatchObject(
    {
      status: 'manual',
      reason: 'Native Auth and Storage operations require service-specific authorization',
    }
  )
})
