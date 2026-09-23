import { describe, expect, it } from 'vitest'

import { compilePermissions, permissionsSql } from '../src/import/permissions'
import { analyze } from '../src/import/plan'
import { assertSessionConnection } from '../src/import/restore'
import { buildSchema } from '../src/import/sql'
import { entries, fullEntries } from './fixtures'

function planWith(rules: unknown, input = entries()) {
  const config = JSON.parse(input.get('config.json')!.toString())
  config.rules = rules
  input.set('config.json', Buffer.from(JSON.stringify(config)))
  return analyze(input)
}
describe('human-readable imports', () => {
  it('uses SQL boolean keywords instead of string-coerced booleans', () => {
    const sql = permissionsSql(
      compilePermissions(planWith({ people: { allow: { view: 'true', $default: 'false' } } }))
    )
    expect(sql).toContain('USING (true)')
    expect(sql).not.toContain("USING ('t')")
  })
  it('defers valid but oversized conditions instead of generating unreadable policies', () => {
    const report = compilePermissions(
      planWith({
        people: { allow: { view: `data.name == '${'x'.repeat(1100)}'`, $default: 'false' } },
      })
    )
    expect(report.rules.find((r) => r.namespace === 'people' && r.action === 'view')?.status).toBe(
      'manual'
    )
    expect(permissionsSql(report)).not.toContain('x'.repeat(1100))
  })
  it('puts simple conditions directly into policies without helper schemas or functions', () => {
    const report = compilePermissions(
      planWith({ people: { allow: { view: 'auth.id != null && data.active', $default: 'false' } } })
    )
    const sql = permissionsSql(report)
    expect(sql).toContain('CREATE POLICY')
    expect(sql).toContain('USING')
    expect(sql).toContain('auth.uid()')
    expect(sql).toContain('people.active')
    expect(sql).not.toMatch(
      /CREATE (FUNCTION|SCHEMA)|SECURITY DEFINER|instant_permissions|input_row/
    )
  })
  it.each(["auth.id in data.ref('friends.id')", "'admin' in auth.ref('$user.role.name')"])(
    'hands graph rule %s to the agent instead of generating joins',
    (expression) => {
      const report = compilePermissions(planWith({ people: { allow: { view: expression } } }))
      expect(
        report.rules.find((r) => r.namespace === 'people' && r.action === 'view')?.status
      ).toBe('manual')
      expect(permissionsSql(report)).not.toContain('JOIN')
    }
  )
  it('hands profile identity lookups to the agent instead of bypassing their RLS', () => {
    const report = compilePermissions(
      planWith({ people: { allow: { view: 'auth.id == data.id' } } }, fullEntries())
    )
    expect(report.rules.find((r) => r.namespace === 'people' && r.action === 'view')?.status).toBe(
      'manual'
    )
    expect(permissionsSql(report)).not.toContain('SELECT account')
  })
  it('does not create custom trigger functions for wide unique attributes', () => {
    const plan = planWith({}, fullEntries())
    const column = plan.namespaces.find((n) => n.source === 'people')!.columns[0]
    column.unique = true
    column.indexMethod = 'hash'
    expect(buildSchema(plan, 'instant_test').join('\n')).not.toMatch(
      /CREATE FUNCTION|CREATE TRIGGER/
    )
    for (const action of ['create', 'update'])
      expect(
        compilePermissions(plan).rules.find((r) => r.namespace === 'people' && r.action === action)
          ?.status
      ).toBe('manual')
  })
})

describe('destination connection', () => {
  it('rejects a transaction pooler that cannot hold the restore session', () => {
    expect(() =>
      assertSessionConnection(
        'postgresql://postgres:pw@aws-0-ap-southeast-2.pooler.example:6543/postgres'
      )
    ).toThrow(/transaction pooler/i)
  })
  it.each([
    'postgresql://postgres:pw@db.example:5432/postgres',
    'postgresql://postgres:pw@aws-0-ap-southeast-2.pooler.example:5432/postgres',
    'postgresql://postgres:pw@db.example/postgres',
  ])('accepts the direct or session connection %s', (url) => {
    expect(() => assertSessionConnection(url)).not.toThrow()
  })
})
