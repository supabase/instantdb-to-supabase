import { randomUUID } from 'node:crypto'
import { ident, safeSql } from '@supabase/pg-meta'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { compilePermissions } from '../src/import/permissions'
import { analyze } from '../src/import/plan'
import { buildSchema } from '../src/import/sql'
import { attr, entries, fullEntries, ids } from './fixtures'

const connectionString = process.env.IMPORT_TEST_DATABASE_URL
if (!connectionString || !['localhost', '127.0.0.1'].includes(new URL(connectionString).hostname))
  throw new Error(
    'RLS integration tests require IMPORT_TEST_DATABASE_URL pointing at a disposable local database'
  )

describe('compiled permissions executed as real Postgres roles', () => {
  const db = new Client({ connectionString })
  beforeAll(() => db.connect())
  afterAll(() => db.end())
  beforeEach(() => db.query('BEGIN'))
  afterEach(() => db.query('ROLLBACK'))
  async function install(rules: unknown, input = entries()) {
    const config = JSON.parse(input.get('config.json')!.toString())
    config.rules = rules
    input.set('config.json', Buffer.from(JSON.stringify(config)))
    if (config.schema.links.friends?.forward.has === 'one')
      input.set(
        'entities/people.jsonl',
        Buffer.from(
          input
            .get('entities/people.jsonl')!
            .toString()
            .split('\n')
            .map((line) => {
              const row = JSON.parse(line)
              if (Array.isArray(row.entity.friends)) row.entity.friends = row.entity.friends[0]
              return JSON.stringify(row)
            })
            .join('\n')
        )
      )
    const plan = analyze(input)
    const schema = `test_permissions_${randomUUID().replaceAll('-', '')}`
    for (const statement of buildSchema(plan, schema)) await db.query(statement)
    await db.query(
      'INSERT INTO public.people(id,name,optional,active,score) VALUES ($1, $2, NULL, false, 0), ($3, $4, $5, true, 3)',
      [ids[0], 'One', ids[1], 'Two', 'visible']
    )
    await db.query('SET CONSTRAINTS ALL IMMEDIATE')
    const result = compilePermissions(plan)
    for (const statement of result.statements) await db.query(statement)
    return { plan, result }
  }
  async function asRole(role: 'anon' | 'authenticated', user: string | null = null) {
    await db.query('RESET ROLE')
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [user ?? ''])
    await db.query(safeSql`SET LOCAL ROLE ${ident(role)}`)
  }
  const visible = async () =>
    (await db.query('SELECT name FROM public.people ORDER BY name')).rows.map((r) => r.name)
  const policy = (view: string) => ({
    $default: { allow: { $default: 'false' } },
    people: { allow: { view } },
  })

  it.each([
    ['true', ['One', 'Two']],
    ['data.active', ['Two']],
    ['!data.active', ['One']],
    ['data.score >= 0 && data.score <= 1', ['One']],
    ["data.name in ['Two', 'Three']", ['Two']],
    ['data.optional == null', ['One']],
    ['data.optional != null', ['Two']],
    ["data.optional == null || data.optional == 'visible'", ['One', 'Two']],
    ['data.name in []', []],
    ['10 < 2', []],
    ['-1 < -2', []],
    ['100 > 2', ['One', 'Two']],
    [`data.name == "x' OR true --"`, []],
  ])('executes scalar predicate %s', async (expression, expected) => {
    const { result } = await install(policy(expression as string))
    expect(result.rules.find((r) => r.namespace === 'people' && r.action === 'view')?.status).toBe(
      'converted'
    )
    await asRole('anon')
    expect(await visible()).toEqual(expected)
  })
  it('distinguishes anonymous, owner, and another authenticated user', async () => {
    await install(policy('auth.id != null && auth.id == data.id'))
    await asRole('anon')
    expect(await visible()).toEqual([])
    await asRole('authenticated', ids[0])
    expect(await visible()).toEqual(['One'])
    await asRole('authenticated', ids[1])
    expect(await visible()).toEqual(['Two'])
    await asRole('authenticated', ids[2])
    expect(await visible()).toEqual([])
  })
  it.each([
    ['auth.id == data.id', true],
    ["auth.id in data.ref('friends.id')", false],
    ["auth.id in data.ref('friends.befriendedBy.id')", false],
    ["'admin' in auth.ref('$user.role.name')", true],
  ])('keeps unsupported identity and graph operations closed: %s', async (expression, profiles) => {
    const { result } = await install(
      policy(expression as string),
      profiles ? fullEntries() : entries()
    )
    expect(result.rules.find((r) => r.namespace === 'people' && r.action === 'view')?.status).toBe(
      'manual'
    )
    expect(result.statements.join('\n')).not.toContain('CREATE FUNCTION')
    await asRole('authenticated', ids[0])
    await expect(visible()).rejects.toThrow(/permission denied/)
  })
  it('allows owner-only inserts and prevents forged ownership', async () => {
    await install({
      people: {
        allow: { view: 'true', create: 'auth.id != null && auth.id == data.id', $default: 'false' },
      },
    })
    await asRole('authenticated', ids[2])
    await db.query('INSERT INTO public.people(id,name) VALUES ($1,$2)', [ids[2], 'Three'])
    expect(await visible()).toEqual(['One', 'Three', 'Two'])
    await expect(
      db.query('INSERT INTO public.people(id,name) VALUES ($1,$2)', [randomUUID(), 'Forged'])
    ).rejects.toThrow(/row-level security/)
  })
  it('does not allow client changes to relationship columns', async () => {
    const input = entries(),
      config = JSON.parse(input.get('config.json')!.toString())
    config.schema.links.friends.forward.has = 'one'
    input.set('config.json', Buffer.from(JSON.stringify(config)))
    const { plan } = await install(
      { people: { allow: { view: 'true', update: 'auth.id != null', $default: 'false' } } },
      input
    )
    const mapping = plan.links[0].mapping
    if (mapping.kind !== 'foreign_key') throw new Error('Expected FK')
    await asRole('authenticated', ids[2])
    await db.query('UPDATE public.people SET name=$1 WHERE id=$2', ['Updated', ids[0]])
    expect(await visible()).toEqual(['Two', 'Updated'])
    await expect(
      db.query(safeSql`UPDATE public.people SET ${ident(mapping.column)}=$1`, [ids[2]])
    ).rejects.toThrow(/permission denied/)
  })
  it('allows deletes on unlinked tables and blocks anonymous writes', async () => {
    const input = entries(),
      config = JSON.parse(input.get('config.json')!.toString())
    config.schema.links = {}
    input.set('config.json', Buffer.from(JSON.stringify(config)))
    input.set(
      'entities/people.jsonl',
      Buffer.from(
        input
          .get('entities/people.jsonl')!
          .toString()
          .split('\n')
          .map((s) => {
            const row = JSON.parse(s)
            delete row.entity.friends
            return JSON.stringify(row)
          })
          .join('\n')
      )
    )
    await install(
      { people: { allow: { view: 'true', delete: 'auth.id == data.id', $default: 'false' } } },
      input
    )
    await asRole('authenticated', ids[0])
    expect((await db.query('DELETE FROM public.people WHERE id=$1', [ids[1]])).rowCount).toBe(0)
    expect((await db.query('DELETE FROM public.people WHERE id=$1', [ids[0]])).rowCount).toBe(1)
    await asRole('anon')
    expect((await db.query('DELETE FROM public.people')).rowCount).toBe(0)
  })
  it.each([
    { allow: { view: "true || ruleParams.token == 'secret'", $default: 'false' } },
    { allow: { view: 'true', $default: 'false' }, fields: { optional: 'false' } },
  ])('keeps incomplete view conversions inaccessible', async (definition) => {
    await install({ people: definition })
    await asRole('anon')
    await expect(visible()).rejects.toThrow(/permission denied/)
  })

  it('has no permission helper schema or functions after applying scalar rules', async () => {
    await install(policy('data.active'))
    expect(
      (
        await db.query(
          "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'instant_permissions_%'"
        )
      ).rows
    ).toEqual([])
    await asRole('anon')
    expect(await visible()).toEqual(['Two'])
  })
  it('refuses to merge policies into existing application policies', async () => {
    const { result } = await install(policy('true'))
    await db.query('SAVEPOINT before_permissions')
    await expect(db.query(result.statements[0])).rejects.toThrow(
      /without existing application policies/
    )
    await db.query('ROLLBACK TO SAVEPOINT before_permissions')
    expect(
      (await db.query("SELECT count(*) FROM pg_policies WHERE tablename='people'")).rows[0].count
    ).toBe('1')
  })
})
