import { describe, expect, it } from 'vitest'

import { analyze } from '../src/import/plan'
import { publicTables } from '../src/import/relational'
import { buildSchema } from '../src/import/sql'
import { attr, fullEntries, ids } from './fixtures'
import { nativeInput } from './native-fixture'

describe('native Supabase destinations', () => {
  it('uses Storage object references and creates no duplicate platform tables', () => {
    const plan = analyze(nativeInput())
    expect(publicTables(plan)).not.toEqual(
      expect.arrayContaining(['files', 'streams', 'oauth_providers', 'users'])
    )
    expect(publicTables(plan)).toContain('user_accounts')
    const sql = buildSchema(plan, 'instant_test').join('\n')
    expect(sql).toContain('REFERENCES storage.objects(id)')
    expect(sql).toContain('auth_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL')
    expect(sql).not.toContain('stream_id')
    expect(sql).not.toContain('CREATE TABLE storage.')
    expect(sql).not.toContain('CREATE TABLE auth.')
  })
  it('excludes streams, their links and stream-only files, but retains shared application files', () => {
    const plan = analyze(nativeInput())
    expect(plan.links.some((l) => l.forward.on === '$streams' || l.reverse.on === '$streams')).toBe(
      false
    )
    expect(plan.files.map((f) => f.id)).toEqual([ids[0], ids[2]])
    expect(plan.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'realtime_excluded' }),
        expect.objectContaining({ code: 'oauth_setup' }),
      ])
    )
    expect(plan.sourceTotals.rows).toBeGreaterThan(plan.totals.rows)
  })
  it('gives distinct logical file aliases distinct native objects', () => {
    const plan = analyze(fullEntries())
    expect(new Set(plan.files.map((f) => f.key)).size).toBe(3)
    expect(plan.files[0].bytes).toEqual(plan.files[2].bytes)
  })
  it('maps identity-only users directly to Auth without an empty profile table', () => {
    const input = nativeInput()
    const users = input
      .get('entities/$users.jsonl')!
      .toString()
      .split('\n')
      .map((r) => JSON.parse(r))
    users[1].entity = { id: ids[1], email: 'second@example.invalid' }
    input.set('entities/$users.jsonl', Buffer.from(users.map((r) => JSON.stringify(r)).join('\n')))
    const plan = analyze(input)
    expect(publicTables(plan)).not.toContain('user_accounts')
    expect(buildSchema(plan, 'instant_test').join('\n')).toContain(
      'FOREIGN KEY (owner_id) REFERENCES auth.users(id)'
    )
  })
  it('keeps custom user properties separate from existing profiles and Auth credentials', () => {
    const input = nativeInput(),
      config = JSON.parse(input.get('config.json')!.toString())
    config.schema.entities.$users.attrs.nickname = attr()
    input.set('config.json', Buffer.from(JSON.stringify(config)))
    const plan = analyze(input)
    expect(publicTables(plan)).toEqual(expect.arrayContaining(['profiles', 'user_accounts']))
    const sql = buildSchema(plan, 'instant_test').join('\n')
    const accounts = sql.split('\n').find((s) => s.startsWith('CREATE TABLE public.user_accounts'))!
    expect(accounts).toContain('nickname text')
    expect(accounts).not.toContain('email text')
    expect(accounts).not.toContain('type text')
  })
  it('keeps custom file properties in a domain table only when present', () => {
    const input = fullEntries(),
      config = JSON.parse(input.get('config.json')!.toString())
    config.schema.entities.$files.attrs.caption = attr()
    input.set('config.json', Buffer.from(JSON.stringify(config)))
    const sql = buildSchema(analyze(input), 'instant_test').join('\n')
    expect(sql).toContain('CREATE TABLE public.file_metadata')
    expect(sql).toContain('storage_object_id uuid NOT NULL REFERENCES storage.objects(id)')
    expect(sql).not.toContain('location_id')
  })
  it('uses junctions when the one-valued side belongs to a managed service', () => {
    const input = nativeInput(),
      config = JSON.parse(input.get('config.json')!.toString())
    config.schema.links.avatar.forward.has = 'many'
    config.schema.links.avatar.reverse.has = 'one'
    input.set('config.json', Buffer.from(JSON.stringify(config)))
    input.set(
      'entities/people.jsonl',
      Buffer.from(
        input
          .get('entities/people.jsonl')!
          .toString()
          .replace(`"avatar":"${ids[0]}"`, `"avatar":["${ids[0]}"]`)
      )
    )
    const plan = analyze(input)
    expect(plan.links.find((l) => l.source === 'avatar')!.mapping).toMatchObject({
      kind: 'junction',
      targetUnique: true,
    })
    const sql = buildSchema(plan, 'instant_test').join('\n')
    expect(sql).toContain('ADD UNIQUE (avatar_id)')
    expect(sql).not.toContain('ALTER TABLE storage.')
  })
  it('does not confuse application tables named files or users with system namespaces', () => {
    const input = nativeInput(),
      config = JSON.parse(input.get('config.json')!.toString())
    for (const name of ['files', 'users', 'streams', 'oauthProviders', 'userAccounts'])
      config.schema.entities[name] = { attrs: {} }
    config.schema.entities.$users.attrs.authUserId = attr()
    input.set('config.json', Buffer.from(JSON.stringify(config)))
    const plan = analyze(input)
    const tables = publicTables(plan)
    expect(new Set(tables).size).toBe(tables.length)
    expect(tables).toEqual(expect.arrayContaining(['files', 'users', 'streams', 'oauth_providers']))
    const users = plan.namespaces.find((n) => n.source === '$users')!
    expect(users.columns[0].target).not.toBe('auth_user_id')
  })
  it('blocks unknown declared system namespaces instead of creating public internals', () => {
    const input = nativeInput(),
      config = JSON.parse(input.get('config.json')!.toString())
    config.schema.entities.$sessions = { attrs: {} }
    input.set('config.json', Buffer.from(JSON.stringify(config)))
    expect(() => analyze(input)).toThrow(/Unsupported system namespace/)
  })
})
