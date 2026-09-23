import { randomUUID } from 'node:crypto'
import { getCreateMigrationsTableSQL, getMigrationsSql, ident, safeSql } from '@supabase/pg-meta'
import { createClient } from '@supabase/supabase-js'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { schemaFingerprint } from '../src/import/fingerprint'
import { readBackupFolder } from '../src/import/input'
import { migrationFile, migrationFor } from '../src/import/migrations'
import { compilePermissions } from '../src/import/permissions'
import { analyze } from '../src/import/plan'
import { publicTables } from '../src/import/relational'
import { restore as restoreSnapshot, type RestoreOptions, type Target } from '../src/import/restore'
import { qualified } from '../src/import/sql'
import type { Plan } from '../src/import/types'
import { attr, entries, fullEntries, ids } from './fixtures'
import { nativeInput } from './native-fixture'

// Keep temporary state only in tests that exercise interrupted restores and drift checks.
const restore = (plan: Plan, target: Target, options: RestoreOptions = {}) =>
  restoreSnapshot(plan, target, { retainImportState: true, ...options })

// Explicit credentials must point at a disposable, blank local Supabase stack.
const target: Target = {
  databaseUrl: process.env.IMPORT_TEST_DATABASE_URL!,
  supabaseUrl: process.env.IMPORT_TEST_SUPABASE_URL!,
  serviceRoleKey: process.env.IMPORT_TEST_SERVICE_ROLE_KEY!,
}
if (!Object.values(target).every(Boolean))
  throw new Error('Set all three IMPORT_TEST_* variables to run real Supabase integration tests.')
if (
  !['localhost', '127.0.0.1'].includes(new URL(target.supabaseUrl).hostname) ||
  !['localhost', '127.0.0.1'].includes(new URL(target.databaseUrl).hostname)
)
  throw new Error('Integration tests require local endpoints.')

describe('blank local Supabase', () => {
  const db = new Client({ connectionString: target.databaseUrl })
  const api = createClient(target.supabaseUrl, target.serviceRoleKey, {
    auth: { persistSession: false },
  })
  let schema: string
  let currentPlan: Plan
  beforeAll(async () => {
    await db.connect()
  })
  afterAll(async () => {
    await db.end()
  })
  afterEach(async () => {
    await db.query('RESET ROLE')
    if (!schema) return
    const present = await db.query('SELECT to_regclass($1) AS table', [`${schema}.restore_job`])
    if (present.rows[0].table) {
      for (const table of publicTables(currentPlan).reverse())
        await db.query(safeSql`DROP TABLE IF EXISTS ${qualified('public', table)} CASCADE`)
      const job = (
        await db.query(
          safeSql`SELECT owner, bucket, migration_version FROM ${qualified(schema, 'restore_job')}`
        )
      ).rows[0]
      const history = await db.query(
        "SELECT to_regclass('supabase_migrations.schema_migrations') AS table"
      )
      if (history.rows[0].table)
        await db.query('DELETE FROM supabase_migrations.schema_migrations WHERE version=$1', [
          job.migration_version,
        ])
      const users = (
        await db.query(
          safeSql`SELECT id FROM auth.users WHERE raw_app_meta_data->>'instant_import_owner' = $1`,
          [job.owner]
        )
      ).rows
      for (const user of users) {
        const r = await api.auth.admin.deleteUser(user.id)
        if (r.error) throw r.error
      }
      const files = (
        await db.query('SELECT name FROM storage.objects WHERE bucket_id=$1', [job.bucket])
      ).rows.map((r) => r.name)
      if (files.length) {
        const r = await api.storage.from(job.bucket).remove(files)
        if (r.error) throw r.error
      }
      const bucket = await api.storage.getBucket(job.bucket)
      if (bucket.data) {
        const r = await api.storage.deleteBucket(job.bucket)
        if (r.error) throw r.error
      }
    }
    if (present.rows[0].table)
      for (const table of publicTables(currentPlan).reverse())
        await db.query(safeSql`DROP TABLE IF EXISTS ${qualified('public', table)} CASCADE`)
    await db.query(safeSql`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`)
  })
  const start = (input: Map<string, Buffer> = entries()) => {
    schema = `instant_test_${randomUUID().replaceAll('-', '')}`
    currentPlan = analyze(input)
    return currentPlan
  }
  it('commits and verifies typed values, provenance, links, and empty tables', async () => {
    const plan = start()
    const report = await restore(plan, target, { schema })
    expect(report.state).toBe('restored_setup_required')
    expect(report.verified).toEqual(plan.totals)
    const ns = plan.namespaces.find((x) => x.source === 'people')!
    const rows = await db.query(
      safeSql`SELECT * FROM ${qualified('public', ns.target)} ORDER BY id`
    )
    expect(rows.rows[0]).not.toHaveProperty('source_record')
    const provenance = await db.query(
      safeSql`SELECT source_record FROM ${qualified(schema, 'provenance')} WHERE table_name=$1 ORDER BY id`,
      [ns.target]
    )
    expect(provenance.rows[0].source_record).toEqual(ns.rows[0].raw)
    expect(rows.rows[0][ns.columns.find((c) => c.source === 'active')!.target]).toBe(false)
  })
  it('removes temporary state by default and records only application SQL', async () => {
    const plan = start()
    const report = await restoreSnapshot(plan, target, { schema })
    expect(report.metadataSchema).toBeNull()
    expect((await db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rows).toEqual(
      []
    )
    expect((await db.query('SELECT count(*) AS n FROM public.people')).rows[0].n).toBe('2')
    const migration = (
      await db.query(
        'SELECT statements FROM supabase_migrations.schema_migrations WHERE version=$1',
        [report.migration.version]
      )
    ).rows[0]
    expect(migration.statements.join('\n')).not.toContain(schema)
    for (const table of publicTables(plan).reverse())
      await db.query(safeSql`DROP TABLE public.${ident(table)} CASCADE`)
    await db.query('DELETE FROM supabase_migrations.schema_migrations WHERE version=$1', [
      report.migration.version,
    ])
  })
  it('resumes without duplicating SQL, Auth, or Storage', async () => {
    const plan = start(fullEntries())
    const first = await restore(plan, target, { schema })
    const second = await restore(plan, target, { schema })
    expect(second.verified).toEqual(first.verified)
    expect(second.revision).toBe(2)
    expect((await api.auth.admin.listUsers()).data.users).toHaveLength(1)
    expect((await db.query('SELECT count(*) FROM storage.objects')).rows[0].count).toBe('3')
  })
  it.each([
    'database_committed',
    'application_committed',
    'auth_created',
    'bucket_planned',
    'bucket_created',
    'file_uploaded',
    'verified',
  ] as const)('resumes after interruption at %s', async (checkpoint) => {
    const plan = start(fullEntries())
    await expect(
      restore(plan, target, {
        schema,
        onCheckpoint: (point) => {
          if (point === checkpoint) throw new Error('worker interrupted')
        },
      })
    ).rejects.toThrow('worker interrupted')
    expect((await restore(plan, target, { schema })).verified).toEqual(plan.totals)
  })
  it('preserves original Auth UUIDs without email confirmation or guest claims', async () => {
    const plan = start(fullEntries())
    await restore(plan, target, { schema })
    const { data } = await api.auth.admin.listUsers()
    expect(data.users.map((u) => u.id)).toEqual([ids[0]])
    expect(data.users[0].email_confirmed_at).toBeFalsy()
    expect(data.users[0].user_metadata).not.toHaveProperty('instant_import_owner')
    expect((await api.auth.admin.getUserById(ids[1])).data.user).toBeNull()
    if (new URL(target.supabaseUrl).port === '56321') {
      const mail = await fetch(
        new URL('/api/v1/messages', target.supabaseUrl.replace(':56321', ':56324'))
      )
      expect((await mail.json()).total).toBe(0)
    }
  })
  it('denies client SQL, REST, and Storage access', async () => {
    const plan = start(fullEntries())
    const result = await restore(plan, target, { schema })
    for (const role of ['anon', 'authenticated']) {
      await db.query(safeSql`SET ROLE ${ident(role)}`)
      try {
        await expect(
          db.query(safeSql`SELECT * FROM ${qualified('public', publicTables(plan)[0])}`)
        ).rejects.toThrow(/permission denied/)
      } finally {
        await db.query('RESET ROLE')
      }
    }
    const publicFile = await fetch(
      `${target.supabaseUrl}/storage/v1/object/public/${result.bucket}/${ids[0]}`
    )
    expect(publicFile.ok).toBe(false)
    const rest = await fetch(`${target.supabaseUrl}/rest/v1/${publicTables(plan)[0]}`)
    expect(rest.ok).toBe(false)
  })
  it('enforces declared required attributes in the destination', async () => {
    const plan = start()
    await restore(plan, target, { schema })
    const people = plan.namespaces.find((n) => n.source === 'people')!
    const column = people.columns.find((c) => c.source === 'name')!
    await expect(
      db.query(
        safeSql`UPDATE ${qualified('public', people.target)} SET ${ident(column.target)}=NULL WHERE id=$1`,
        [ids[0]]
      )
    ).rejects.toThrow(/not-null/)
  })
  it('enforces endpoint FKs and one-to-one cardinality', async () => {
    const input = entries(),
      config = JSON.parse(input.get('config.json')!.toString())
    config.schema.links.friends.forward.has = 'one'
    config.schema.links.friends.reverse.has = 'one'
    input.set('config.json', Buffer.from(JSON.stringify(config)))
    const rows = input
      .get('entities/people.jsonl')!
      .toString()
      .split('\n')
      .map((s) => JSON.parse(s))
    rows[0].entity.friends = ids[1]
    input.set('entities/people.jsonl', Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n')))
    const plan = start(input)
    await restore(plan, target, { schema })
    const m = plan.links[0].mapping
    if (m.kind !== 'foreign_key') throw new Error('Expected a foreign key')
    await expect(
      db.query(
        safeSql`UPDATE ${qualified('public', m.table)} SET ${ident(m.column)}=$1 WHERE id=$2`,
        [ids[2], ids[0]]
      )
    ).rejects.toThrow(/foreign key/)
    await expect(
      db.query(
        safeSql`UPDATE ${qualified('public', m.table)} SET ${ident(m.column)}=$1 WHERE id=$2`,
        [ids[1], ids[1]]
      )
    ).rejects.toThrow(/unique/)
  })
  it.each(['row', 'edge', 'schema', 'grant', 'file_registry', 'auth_map'] as const)(
    'refuses to overwrite %s drift',
    async (kind) => {
      const plan = start(fullEntries())
      await restore(plan, target, { schema })
      const people = plan.namespaces.find((n) => n.source === 'people')!
      if (kind === 'row')
        await db.query(
          safeSql`UPDATE ${qualified('public', people.target)} SET ${ident(people.columns.find((c) => c.source === 'name')!.target)}='Changed' WHERE id=$1`,
          [ids[0]]
        )
      if (kind === 'edge')
        await db.query(safeSql`DELETE FROM ${qualified('public', plan.links[0].target)}`)
      if (kind === 'schema')
        await db.query(
          safeSql`ALTER TABLE ${qualified('public', people.target)} ADD COLUMN extra text`
        )
      if (kind === 'grant') await db.query(safeSql`GRANT USAGE ON SCHEMA ${ident(schema)} TO anon`)
      if (kind === 'file_registry')
        await db.query(safeSql`UPDATE ${qualified(schema, 'file_registry')} SET object_key='other'`)
      if (kind === 'auth_map')
        await db.query(
          safeSql`UPDATE ${qualified(schema, 'auth_map')} SET email='other@example.invalid' WHERE email IS NOT NULL`
        )
      await expect(restore(plan, target, { schema })).rejects.toThrow(/verification|drift/i)
    }
  )
  it('rejects changed destination file bytes without replacing them', async () => {
    const plan = start(fullEntries())
    const result = await restore(plan, target, { schema })
    await api.storage
      .from(result.bucket!)
      .update(ids[0], Buffer.from('wrong'), { contentType: 'text/plain' })
    await expect(restore(plan, target, { schema })).rejects.toThrow(/hash verification/)
  })
  it('blocks populated destinations before creating a schema', async () => {
    const plan = start()
    const table = `test_existing_${randomUUID().replaceAll('-', '')}`
    await db.query(safeSql`CREATE TABLE public.${ident(table)} (id integer)`)
    try {
      await expect(restore(plan, target, { schema })).rejects.toThrow(/not blank/)
      expect(
        (await db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount
      ).toBe(0)
    } finally {
      await db.query(safeSql`DROP TABLE public.${ident(table)}`)
    }
  })
  it('blocks existing Auth identities without linking by email', async () => {
    const plan = start(fullEntries())
    const { data, error } = await api.auth.admin.createUser({
      email: 'import-test@example.invalid',
    })
    if (error) throw error
    try {
      await expect(restore(plan, target, { schema })).rejects.toThrow(/conflicting users/)
    } finally {
      await api.auth.admin.deleteUser(data.user.id)
    }
  })
  it('blocks concurrent restore workers', async () => {
    const plan = start()
    await db.query('SELECT pg_advisory_lock(1735289201,1)')
    try {
      await expect(restore(plan, target, { schema })).rejects.toThrow(/Another restore/)
    } finally {
      await db.query('SELECT pg_advisory_unlock(1735289201,1)')
    }
  })
  it('round-trips NUL encoding and float boundary values', async () => {
    const input = entries()
    const rows = input
      .get('entities/people.jsonl')!
      .toString()
      .split('\n')
      .map((s) => JSON.parse(s))
    rows[0].entity.name = 'a\0b'
    rows[0].entity.score = 0.30000000000000004
    rows[1].entity.score = Number.MAX_SAFE_INTEGER
    input.set('entities/people.jsonl', Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n')))
    const plan = start(input)
    expect((await restore(plan, target, { schema })).verified.rows).toBe(2)
  })
  it('hands long unique values to a manual constraint task without custom triggers', async () => {
    const input = entries()
    const config = JSON.parse(input.get('config.json')!.toString())
    config.schema.entities.people.attrs.name = attr('string', { config: { unique: true } })
    input.set('config.json', Buffer.from(JSON.stringify(config)))
    const rows = input
      .get('entities/people.jsonl')!
      .toString()
      .split('\n')
      .map((s) => JSON.parse(s))
    rows[0].entity.name = 'original'.repeat(2000)
    input.set('entities/people.jsonl', Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n')))
    const plan = start(input)
    await restore(plan, target, { schema })
    expect(
      compilePermissions(plan)
        .rules.filter((r) => r.namespace === 'people' && ['create', 'update'].includes(r.action))
        .every((r) => r.status === 'manual')
    ).toBe(true)
    expect(
      (
        await db.query(
          "SELECT tgname FROM pg_trigger WHERE tgrelid='public.people'::regclass AND NOT tgisinternal"
        )
      ).rows
    ).toEqual([])
    expect(plan.diagnostics.some((d) => d.code === 'manual_unique_constraint')).toBe(true)
  })
  it('rolls back the entire database stage on a SQL constraint failure', async () => {
    const plan = start()
    const people = plan.namespaces.find((n) => n.source === 'people')!
    people.rows.push(people.rows[0])
    await expect(restore(plan, target, { schema })).rejects.toThrow(/duplicate key/)
    expect((await db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount).toBe(
      0
    )
    expect((await api.auth.admin.listUsers()).data.users).toHaveLength(0)
  })
  it('blocks email case collisions before SQL writes', async () => {
    const input = fullEntries()
    const rows = input
      .get('entities/$users.jsonl')!
      .toString()
      .split('\n')
      .map((x) => JSON.parse(x))
    rows[1].entity = { id: ids[1], email: 'IMPORT-TEST@example.invalid' }
    input.set('entities/$users.jsonl', Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n')))
    const plan = start(input)
    await expect(restore(plan, target, { schema })).rejects.toThrow(/Auth email/)
    expect((await db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount).toBe(
      0
    )
  })
  it('blocks preexisting buckets before SQL writes', async () => {
    const plan = start()
    const bucket = `existing-${randomUUID()}`
    const r = await api.storage.createBucket(bucket)
    if (r.error) throw r.error
    try {
      await expect(restore(plan, target, { schema })).rejects.toThrow(/conflicting buckets/)
    } finally {
      await api.storage.deleteBucket(bucket)
    }
  })
  it('refuses a different content hash at an existing import schema', async () => {
    const plan = start()
    await restore(plan, target, { schema })
    await expect(
      restore({ ...plan, contentHash: '0'.repeat(64) }, target, { schema })
    ).rejects.toThrow(/ownership or version conflict/)
  })
  it('restores cyclic self-links and uses SET NULL for optional references', async () => {
    const input = entries(),
      config = JSON.parse(input.get('config.json')!.toString())
    config.schema.links.friends.forward.has = 'one'
    config.schema.links.friends.forward.label = 'parent'
    input.set('config.json', Buffer.from(JSON.stringify(config)))
    const rows = input
      .get('entities/people.jsonl')!
      .toString()
      .split('\n')
      .map((x) => JSON.parse(x))
    delete rows[0].entity.friends
    rows[0].entity.parent = ids[1]
    rows[1].entity.parent = ids[0]
    input.set('entities/people.jsonl', Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n')))
    const plan = start(input)
    await restore(plan, target, { schema })
    expect((await db.query('SELECT id,parent_id FROM public.people ORDER BY id')).rows).toEqual([
      { id: ids[0], parent_id: ids[1] },
      { id: ids[1], parent_id: ids[0] },
    ])
    await db.query('DELETE FROM public.people WHERE id=$1', [ids[0]])
    expect((await db.query('SELECT parent_id FROM public.people')).rows[0].parent_id).toBeNull()
  })
  it('honors reverse-declared cascades and required FKs', async () => {
    const input = entries(),
      config = JSON.parse(input.get('config.json')!.toString())
    config.schema.entities.parents = { attrs: { name: attr() } }
    config.schema.links = {
      children: {
        forward: { on: 'parents', label: 'children', has: 'many' },
        reverse: { on: 'people', label: 'parent', has: 'one', required: true, onDelete: 'cascade' },
      },
    }
    config.counts.parents = 1
    input.set('config.json', Buffer.from(JSON.stringify(config)))
    const rows = input
      .get('entities/people.jsonl')!
      .toString()
      .split('\n')
      .map((x) => JSON.parse(x))
    delete rows[0].entity.friends
    input.set('entities/people.jsonl', Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n')))
    input.set(
      'entities/parents.jsonl',
      Buffer.from(
        JSON.stringify({
          entity: { id: ids[2], name: 'Parent', children: [ids[0], ids[1]] },
          createdAt: 0,
        })
      )
    )
    const plan = start(input)
    await restore(plan, target, { schema })
    expect((await db.query('SELECT DISTINCT parent_id FROM public.people')).rows).toEqual([
      { parent_id: ids[2] },
    ])
    await expect(db.query('UPDATE public.people SET parent_id=NULL')).rejects.toThrow(/not-null/)
    await db.query('DELETE FROM public.parents WHERE id=$1', [ids[2]])
    expect((await db.query('SELECT count(*) FROM public.people')).rows[0].count).toBe('0')
  })
  it('removes only junction rows when a many-to-many endpoint is deleted', async () => {
    const plan = start()
    await restore(plan, target, { schema })
    await db.query('DELETE FROM public.people WHERE id=$1', [ids[0]])
    expect((await db.query('SELECT count(*) FROM public.people_friends')).rows[0].count).toBe('0')
    expect((await db.query('SELECT id FROM public.people')).rows).toEqual([{ id: ids[1] }])
  })
  it('creates conventional unique constraints and ordered indexes', async () => {
    const input = entries(),
      config = JSON.parse(input.get('config.json')!.toString())
    config.schema.entities.people.attrs.name = attr('string', {
      config: { unique: true, indexed: true },
    })
    config.schema.entities.people.attrs.date = attr('date', { config: { indexed: true } })
    input.set('config.json', Buffer.from(JSON.stringify(config)))
    const plan = start(input)
    await restore(plan, target, { schema })
    expect(
      (
        await db.query(
          "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.people'::regclass AND contype='u'"
        )
      ).rows
    ).toEqual([{ definition: 'UNIQUE (name)' }])
    expect(
      (
        await db.query(
          "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='people'"
        )
      ).rows.some((r) => r.indexdef.includes('USING btree (date)'))
    ).toBe(true)
    await expect(
      db.query("UPDATE public.people SET name='One' WHERE id=$1", [ids[1]])
    ).rejects.toThrow(/unique/)
  })

  it('rewires scalar and junction file links to native Storage IDs without alias collisions', async () => {
    const plan = start(nativeInput())
    const result = await restore(plan, target, { schema })
    expect((await db.query("SELECT to_regclass('public.files') AS table")).rows[0].table).toBeNull()
    const joined = await db.query(
      'SELECT o.name FROM public.people p JOIN storage.objects o ON o.id=p.avatar_id WHERE p.id=$1',
      [ids[0]]
    )
    expect(joined.rows).toEqual([{ name: ids[0] }])
    expect(
      (
        await db.query(
          'SELECT o.name FROM public.people_attachments a JOIN storage.objects o ON o.id=a.attachment_id ORDER BY o.name'
        )
      ).rows
    ).toEqual([{ name: ids[0] }, { name: ids[2] }])
    expect((await db.query('SELECT name FROM storage.objects ORDER BY name')).rows).toEqual([
      { name: ids[0] },
      { name: ids[2] },
    ])
    expect((await api.storage.from(result.bucket!).download(ids[1])).error).toBeTruthy()
    expect((await restore(plan, target, { schema })).revision).toBe(2)
    await expect(db.query('UPDATE public.people SET avatar_id=$1', [ids[1]])).rejects.toThrow(
      /foreign key/
    )
  })
  it('keeps guest relationships without fabricating Auth identities or copying login attributes', async () => {
    const plan = start(nativeInput())
    await restore(plan, target, { schema })
    expect(
      (await db.query('SELECT id,auth_user_id FROM public.user_accounts ORDER BY id')).rows
    ).toEqual([
      { id: ids[0], auth_user_id: ids[0] },
      { id: ids[1], auth_user_id: null },
    ])
    expect((await db.query('SELECT owner_id FROM public.people ORDER BY id')).rows).toEqual([
      { owner_id: ids[0] },
      { owner_id: ids[1] },
    ])
    const deleted = await api.auth.admin.deleteUser(ids[0])
    expect(deleted.error).toBeNull()
    expect(
      (await db.query('SELECT auth_user_id FROM public.user_accounts WHERE id=$1', [ids[0]]))
        .rows[0].auth_user_id
    ).toBeNull()
    expect((await db.query('SELECT count(*) FROM public.people')).rows[0].count).toBe('2')
  })
  it('uses Auth primary keys directly when users have no application properties or guests', async () => {
    const input = nativeInput()
    const users = input
      .get('entities/$users.jsonl')!
      .toString()
      .split('\n')
      .map((r) => JSON.parse(r))
    users[1].entity = { id: ids[1], email: 'second@example.invalid' }
    input.set('entities/$users.jsonl', Buffer.from(users.map((r) => JSON.stringify(r)).join('\n')))
    const plan = start(input)
    await restore(plan, target, { schema })
    expect(
      (await db.query("SELECT to_regclass('public.user_accounts') AS table")).rows[0].table
    ).toBeNull()
    expect(
      (await db.query('SELECT count(*) FROM public.people p JOIN auth.users u ON u.id=p.owner_id'))
        .rows[0].count
    ).toBe('2')
  })
  it('imports custom file attributes alongside a required native object reference', async () => {
    const input = fullEntries(),
      config = JSON.parse(input.get('config.json')!.toString())
    config.schema.entities.$files.attrs.caption = attr()
    input.set('config.json', Buffer.from(JSON.stringify(config)))
    const rows = input
      .get('entities/$files.jsonl')!
      .toString()
      .split('\n')
      .map((r) => JSON.parse(r))
    rows[0].entity.caption = 'A custom caption'
    input.set('entities/$files.jsonl', Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n')))
    const plan = start(input)
    await restore(plan, target, { schema })
    expect(
      (
        await db.query(
          'SELECT caption FROM public.file_metadata f JOIN storage.objects o ON o.id=f.storage_object_id WHERE f.id=$1',
          [ids[0]]
        )
      ).rows
    ).toEqual([{ caption: 'A custom caption' }])
    await expect(
      db.query('UPDATE public.file_metadata SET storage_object_id=NULL')
    ).rejects.toThrow(/not-null/)
  })
  it.each([
    'database_committed',
    'auth_created',
    'file_uploaded',
    'application_committed',
  ] as const)('recovers native relationships after interruption at %s', async (checkpoint) => {
    const plan = start(nativeInput())
    await expect(
      restore(plan, target, {
        schema,
        onCheckpoint: (point) => {
          if (point === checkpoint) throw new Error('interrupted')
        },
      })
    ).rejects.toThrow('interrupted')
    await restore(plan, target, { schema })
    expect(
      (
        await db.query(
          'SELECT count(*) FROM public.people p JOIN storage.objects o ON o.id=p.avatar_id'
        )
      ).rows[0].count
    ).toBe('1')
  })
  it('detects native file reference drift without repairing application data', async () => {
    const plan = start(nativeInput())
    await restore(plan, target, { schema })
    await db.query('UPDATE public.people SET avatar_id=NULL')
    await expect(restore(plan, target, { schema })).rejects.toThrow(/Relationship verification/)
  })
  it('rejects a replacement Storage object even if its bytes match', async () => {
    const plan = start(fullEntries())
    const result = await restore(plan, target, { schema })
    expect((await api.storage.from(result.bucket!).remove([ids[0]])).error).toBeNull()
    expect(
      (
        await api.storage.from(result.bucket!).upload(ids[0], Buffer.from('hello'), {
          contentType: 'text/plain',
          metadata: { original_path: '資料/hello.txt' },
        })
      ).error
    ).toBeNull()
    await expect(restore(plan, target, { schema })).rejects.toThrow(/object identity verification/)
  })
  it('keeps all source provenance private while reporting realtime exclusions separately', async () => {
    const plan = start(nativeInput())
    const report = await restore(plan, target, { schema })
    expect(report.sourceTotals).toEqual(plan.sourceTotals)
    expect(report.verified.rows).toBeLessThan(report.sourceTotals.rows)
    expect(
      (await db.query(safeSql`SELECT count(*) FROM ${qualified(schema, 'provenance')}`)).rows[0]
        .count
    ).toBe(String(plan.sourceTotals.rows))
    expect(
      (
        await db.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='people'"
        )
      ).rows.map((r) => r.column_name)
    ).not.toContain('stream_id')
  })

  it('rolls back all application inserts on failure, then resumes with native services intact', async () => {
    const plan = start(nativeInput())
    const row = plan.namespaces.find((ns) => ns.source === 'people')!.rows[0]
    const originalName = row.values.name
    row.values.name = null
    await expect(restore(plan, target, { schema })).rejects.toThrow(/not-null/)
    expect((await db.query('SELECT count(*) FROM public.people')).rows[0].count).toBe('0')
    expect((await db.query('SELECT count(*) FROM public.user_accounts')).rows[0].count).toBe('0')
    expect(
      (await db.query(safeSql`SELECT data_loaded FROM ${qualified(schema, 'restore_job')}`)).rows[0]
        .data_loaded
    ).toBe(false)
    row.values.name = originalName
    await restore(plan, target, { schema })
    expect((await db.query('SELECT count(*) FROM public.people')).rows[0].count).toBe('2')
  })
  it('detects unexpected application rows before resuming a pending database stage', async () => {
    const plan = start(nativeInput())
    await expect(
      restore(plan, target, {
        schema,
        onCheckpoint: (point) => {
          if (point === 'database_committed') throw new Error('interrupted')
        },
      })
    ).rejects.toThrow('interrupted')
    await db.query("INSERT INTO public.people (name) VALUES ('Unexpected')")
    await expect(restore(plan, target, { schema })).rejects.toThrow(/Row count verification/)
    expect((await api.auth.admin.listUsers()).data.users).toHaveLength(0)
  })
  it('preserves logical paths and content disposition in native Storage metadata', async () => {
    const input = fullEntries()
    const rows = input
      .get('entities/$files.jsonl')!
      .toString()
      .split('\n')
      .map((r) => JSON.parse(r))
    rows[0].entity['content-disposition'] = 'attachment; filename="hello.txt"'
    rows[1].entity.path = 'nul\0path'
    input.set('entities/$files.jsonl', Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n')))
    const plan = start(input)
    const report = await restore(plan, target, { schema })
    const metadata = (
      await db.query('SELECT name,user_metadata FROM storage.objects ORDER BY name')
    ).rows
    expect(metadata[0].user_metadata).toEqual({
      original_path: '資料/hello.txt',
      original_content_disposition: 'attachment; filename="hello.txt"',
    })
    expect(Buffer.from(metadata[1].user_metadata.original_path_base64, 'base64').toString()).toBe(
      'nul\0path'
    )
    const changed = await api.storage.from(report.bucket!).update(ids[0], Buffer.from('hello'), {
      contentType: 'text/plain',
      metadata: { original_path: 'different' },
    })
    expect(changed.error).toBeNull()
    await expect(restore(plan, target, { schema })).rejects.toThrow(/File metadata verification/)
  })

  it('restores one-to-one links between two native services without modifying their tables', async () => {
    const input = nativeInput(),
      config = JSON.parse(input.get('config.json')!.toString())
    config.schema.links.userAvatar = {
      forward: { on: '$users', label: 'avatar', has: 'one' },
      reverse: { on: '$files', label: 'user', has: 'one' },
    }
    input.set('config.json', Buffer.from(JSON.stringify(config)))
    const users = input
      .get('entities/$users.jsonl')!
      .toString()
      .split('\n')
      .map((r) => JSON.parse(r))
    users[0].entity.avatar = ids[0]
    users[1].entity = { id: ids[1], email: 'second@example.invalid' }
    input.set('entities/$users.jsonl', Buffer.from(users.map((r) => JSON.stringify(r)).join('\n')))
    const plan = start(input)
    await restore(plan, target, { schema })
    expect(
      (
        await db.query(
          'SELECT u.id,o.name FROM public.users_avatar a JOIN auth.users u ON u.id=a.user_id JOIN storage.objects o ON o.id=a.avatar_id'
        )
      ).rows
    ).toEqual([{ id: ids[0], name: ids[0] }])
    await expect(
      db.query('INSERT INTO public.users_avatar SELECT $1,avatar_id FROM public.users_avatar', [
        ids[1],
      ])
    ).rejects.toThrow(/unique/)
    const object = (await db.query('SELECT id FROM storage.objects WHERE name=$1', [ids[2]]))
      .rows[0].id
    await expect(
      db.query('INSERT INTO public.users_avatar VALUES ($1,$2)', [ids[0], object])
    ).rejects.toThrow(/unique/)
    expect((await restore(plan, target, { schema })).revision).toBe(2)
  })

  it('records exact schema statements visible to Studio and does not duplicate them on retry', async () => {
    const plan = start(nativeInput())
    const report = await restore(plan, target, { schema })
    const migration = migrationFor(plan, report.migration.version)
    const results = await db.query(getMigrationsSql())
    const rows: { version: string; name: string; statements: string[] }[] = Array.isArray(results)
      ? results.at(-1)!.rows
      : results.rows
    expect(rows.find((r) => r.version === migration.version)).toEqual({
      version: migration.version,
      name: migration.name,
      statements: migration.statements,
    })
    expect(report.migration.fileName).toBe(migration.fileName)
    const second = await restore(plan, target, { schema })
    expect(second.migration).toEqual(report.migration)
    expect(
      (
        await db.query(
          'SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version=$1',
          [migration.version]
        )
      ).rows[0].count
    ).toBe('1')
  })
  it.each(['deleted', 'renamed', 'changed SQL'] as const)(
    'detects %s migration history without silently repairing it',
    async (kind) => {
      const plan = start()
      const { migration } = await restore(plan, target, { schema })
      if (kind === 'deleted')
        await db.query('DELETE FROM supabase_migrations.schema_migrations WHERE version=$1', [
          migration.version,
        ])
      if (kind === 'renamed')
        await db.query(
          "UPDATE supabase_migrations.schema_migrations SET name='changed' WHERE version=$1",
          [migration.version]
        )
      if (kind === 'changed SQL')
        await db.query(
          "UPDATE supabase_migrations.schema_migrations SET statements=ARRAY['SELECT 1'] WHERE version=$1",
          [migration.version]
        )
      await expect(restore(plan, target, { schema })).rejects.toThrow(
        /Migration history verification/
      )
      expect((await db.query('SELECT count(*) FROM public.people')).rows[0].count).toBe('2')
    }
  )
  it('rolls schema creation back if migration history cannot be recorded', async () => {
    const plan = start()
    await db.query(getCreateMigrationsTableSQL())
    await db.query(
      'ALTER TABLE supabase_migrations.schema_migrations ADD CONSTRAINT reject_test_migration CHECK (false) NOT VALID'
    )
    try {
      await expect(restore(plan, target, { schema })).rejects.toThrow(/reject_test_migration/)
      expect(
        (await db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount
      ).toBe(0)
      expect(
        (await db.query("SELECT to_regclass('public.people') AS table")).rows[0].table
      ).toBeNull()
    } finally {
      await db.query(
        'ALTER TABLE supabase_migrations.schema_migrations DROP CONSTRAINT reject_test_migration'
      )
    }
  })
  it('supports missing and version-only history tables without changing earlier entries', async () => {
    const plan = start()
    await db.query(getCreateMigrationsTableSQL())
    await db.query('ALTER TABLE supabase_migrations.schema_migrations RENAME TO saved_test_history')
    try {
      await db.query(
        'CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY)'
      )
      await db.query("INSERT INTO supabase_migrations.schema_migrations VALUES ('20000101000000')")
      await restore(plan, target, { schema })
      expect(
        (
          await db.query(
            "SELECT * FROM supabase_migrations.schema_migrations WHERE version='20000101000000'"
          )
        ).rows
      ).toEqual([{ version: '20000101000000', statements: null, name: null }])
    } finally {
      await db.query('DROP TABLE supabase_migrations.schema_migrations')
      await db.query(
        'ALTER TABLE supabase_migrations.saved_test_history RENAME TO schema_migrations'
      )
    }
  })

  it('creates absent migration history and refuses to silently recreate it on resume', async () => {
    const plan = start()
    await db.query(getCreateMigrationsTableSQL())
    await db.query('ALTER TABLE supabase_migrations.schema_migrations RENAME TO saved_test_history')
    try {
      await restore(plan, target, { schema })
      await db.query('DROP TABLE supabase_migrations.schema_migrations')
      await expect(restore(plan, target, { schema })).rejects.toThrow(
        /Migration history verification failed: history is missing/
      )
    } finally {
      await db.query('DROP TABLE IF EXISTS supabase_migrations.schema_migrations')
      await db.query(
        'ALTER TABLE supabase_migrations.saved_test_history RENAME TO schema_migrations'
      )
    }
  })
  it('records history once schema commits even when Auth or Storage later interrupts', async () => {
    const plan = start(fullEntries())
    await expect(
      restore(plan, target, {
        schema,
        onCheckpoint: (point) => {
          if (point === 'database_committed') throw new Error('interrupted')
        },
      })
    ).rejects.toThrow('interrupted')
    const version = (
      await db.query(safeSql`SELECT migration_version FROM ${qualified(schema, 'restore_job')}`)
    ).rows[0].migration_version
    expect(
      (
        await db.query(
          'SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version=$1',
          [version]
        )
      ).rows[0].count
    ).toBe('1')
    expect((await restore(plan, target, { schema })).migration.version).toBe(version)
  })
  it('replays application-only migrations without recreating temporary state', async () => {
    const input = entries(),
      config = JSON.parse(input.get('config.json')!.toString())
    config.schema.entities.people.attrs.name = attr('string', { config: { unique: true } })
    input.set('config.json', Buffer.from(JSON.stringify(config)))
    const rows = input
      .get('entities/people.jsonl')!
      .toString()
      .split('\n')
      .map((r) => JSON.parse(r))
    rows[0].entity.name = "Quote'; and semicolon;".repeat(100)
    input.set('entities/people.jsonl', Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n')))
    const plan = start(input)
    const report = await restore(plan, target, { schema })
    const migration = migrationFor(plan, report.migration.version)
    const before = await schemaFingerprint(db, 'public')
    for (const table of publicTables(plan).reverse())
      await db.query(safeSql`DROP TABLE ${qualified('public', table)} CASCADE`)
    await db.query(safeSql`DROP SCHEMA ${ident(schema)} CASCADE`)
    try {
      await db.query(migrationFile(migration))
      expect(await schemaFingerprint(db, 'public')).toEqual(before)
      expect(
        (await db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rows
      ).toEqual([])
      expect((await db.query('SELECT count(*) FROM public.people')).rows[0].count).toBe('0')
    } finally {
      for (const table of publicTables(plan).reverse())
        await db.query(safeSql`DROP TABLE IF EXISTS ${qualified('public', table)} CASCADE`)
      await db.query(safeSql`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`)
      await db.query('DELETE FROM supabase_migrations.schema_migrations WHERE version=$1', [
        migration.version,
      ])
    }
  })
  it.skipIf(!process.env.IMPORT_EXAMPLE_PATH)(
    'restores the supplied extracted example with exact expected totals',
    async () => {
      const plan = start(await readBackupFolder(process.env.IMPORT_EXAMPLE_PATH!))
      expect(publicTables(plan)).not.toEqual(
        expect.arrayContaining(['files', 'users', 'streams', 'oauth_providers'])
      )
      expect(plan.sourceTotals).toEqual({
        namespaces: 37,
        rows: 598,
        edges: 1881,
        files: 9,
        bytes: 603,
      })
      expect(publicTables(plan)).toHaveLength(43)
      expect(plan.links.filter((l) => l.mapping.kind === 'foreign_key')).toHaveLength(38)
      expect(plan.totals).toEqual({ namespaces: 35, rows: 591, edges: 1878, files: 7, bytes: 531 })
      expect((await restore(plan, target, { schema })).verified).toEqual(plan.totals)
      expect((await api.auth.admin.listUsers()).data.users).toHaveLength(5)
      const permissions = compilePermissions(plan)
      expect(
        permissions.rules.filter((r) => r.action === 'view' && r.effect === 'allow')
      ).toHaveLength(8)
      expect(
        permissions.rules.find((r) => r.namespace === 'tasks' && r.action === 'view')
      ).toMatchObject({ status: 'manual' })
      await db.query('BEGIN')
      try {
        for (const statement of permissions.statements) await db.query(statement)
        await db.query('SET LOCAL ROLE anon')
        expect(
          (
            await db.query(
              safeSql`SELECT has_table_privilege(current_user, 'public.tasks', 'SELECT') AS allowed`
            )
          ).rows[0].allowed
        ).toBe(false)
        expect((await db.query('SELECT count(id) FROM public.products')).rows[0].count).toBe(
          String(
            plan.namespaces
              .find((n) => n.source === 'products')!
              .rows.filter((row) => row.values.active).length
          )
        )
        expect(
          (
            await db.query(
              "SELECT has_table_privilege(current_user, 'public.documents', 'SELECT') AS allowed"
            )
          ).rows[0].allowed
        ).toBe(false)
        await db.query('RESET ROLE')
        const users = (
          await db.query(
            'SELECT auth_user_id FROM public.user_accounts WHERE auth_user_id IS NOT NULL'
          )
        ).rows
        for (const user of users) {
          await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [
            user.auth_user_id,
          ])
          await db.query('SET LOCAL ROLE authenticated')
          expect(
            (
              await db.query(
                safeSql`SELECT has_table_privilege(current_user, 'public.tasks', 'SELECT') AS allowed`
              )
            ).rows[0].allowed
          ).toBe(false)
          await db.query('RESET ROLE')
        }
      } finally {
        await db.query('ROLLBACK')
      }

      expect(
        (await db.query('SELECT count(*) FROM public.tasks WHERE project_id IS NOT NULL')).rows[0]
          .count
      ).toBe('300')
      expect(
        (
          await db.query(
            "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='tasks'"
          )
        ).rows.map((r) => r.column_name)
      ).toEqual(
        expect.arrayContaining(['id', 'title', 'status', 'due_at', 'project_id', 'parent_id'])
      )
    }
  )
})
