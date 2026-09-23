import { describe, expect, it } from 'vitest'

import { migrationFile, migrationFor, nextMigrationVersion } from '../src/import/migrations'
import { analyze } from '../src/import/plan'
import { buildApplicationSchema } from '../src/import/sql'
import { entries } from './fixtures'

describe('schema migration artifacts', () => {
  it('uses sortable UTC versions and advances across second and year boundaries on collision', () => {
    expect(nextMigrationVersion([], new Date('2026-09-07T12:34:56Z'))).toBe('20260907123456')
    expect(
      nextMigrationVersion(['20261231235959', '20270101000000'], new Date('2026-12-31T23:59:59Z'))
    ).toBe('20270101000001')
  })
  it('records the exact generated statements without source rows, credentials, or history inserts', () => {
    const plan = analyze(entries())
    const migration = migrationFor(plan, '20260907123456')
    expect(migration.statements).toEqual(buildApplicationSchema(plan))
    expect(migrationFile(migration)).not.toContain('instant_test')
    expect(migration.name).toMatch(/^import_schema_[a-f0-9]{12}$/)
    expect(migrationFile(migration)).toContain('CREATE TABLE public.people')
    expect(migrationFile(migration)).not.toContain('INSERT INTO')
    expect(migrationFile(migration)).not.toContain('supabase_migrations')
    expect(migrationFile(migration)).not.toContain('"name":"One"')
  })
  it('rejects malformed versions before making filesystem paths', () => {
    for (const version of ['', '../escape', '2026-09-07'])
      expect(() => migrationFor(analyze(entries()), version)).toThrow(/migration version/i)
  })
})
