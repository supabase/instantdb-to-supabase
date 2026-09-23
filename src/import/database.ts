import { randomUUID } from 'node:crypto'
import { ident, joinSqlFragments, literal, safeSql, type SafeSqlFragment } from '@supabase/pg-meta'
import { Client } from 'pg'

import { schemaFingerprint } from './fingerprint'
import { hash } from './input'
import { byCodeUnit, canonical, type Json } from './json'
import {
  migrationFor,
  prepareMigrationHistory,
  recordMigration,
  verifyMigration,
} from './migrations'
import { applicationNamespaces, applicationRows, hasAuthIdentity } from './native'
import { foreignKeysFor, publicTables } from './relational'
import { buildImportStateSchema, qualified } from './sql'
import type { Column, Plan } from './types'

export type Job = {
  content_hash: string
  version: number
  migration_version: string
  owner: string
  state: string
  revision: string
  bucket: string
  bucket_started: boolean
  bucket_ready: boolean
  data_loaded: boolean
}
const sqlTypes: Record<Column['storage'], SafeSqlFragment> = {
  text: safeSql`text`,
  'double precision': safeSql`double precision`,
  boolean: safeSql`boolean`,
  timestamptz: safeSql`timestamptz`,
  jsonb: safeSql`jsonb`,
  bytea: safeSql`bytea`,
}
const execute = (db: Client, sql: SafeSqlFragment, values?: unknown[]) => db.query(sql, values)
const valueForSql = (value: Json | undefined, column: Column) =>
  value === undefined || value === null
    ? null
    : column.storage === 'bytea'
      ? Buffer.from(canonical(value))
      : column.storage === 'jsonb'
        ? canonical(value)
        : value
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export async function preflight(db: Client, schema: string, owner?: string, tables: string[] = []) {
  const existingTables = await execute(
    db,
    safeSql`SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT IN ('pg_catalog','information_schema','auth','storage','realtime','_realtime','extensions','graphql','graphql_public','supabase_migrations','supabase_functions','vault','pgsodium','pgsodium_masks','net','cron') AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> $1 AND (n.nspname <> 'public' OR NOT c.relname = ANY($2::text[])) LIMIT 1`,
    [schema, tables]
  )
  assert(!existingTables.rowCount, 'Destination is not blank. Use a blank Supabase project.')
  const triggers = await execute(
    db,
    safeSql`SELECT 1 FROM pg_trigger WHERE tgrelid = 'auth.users'::regclass AND NOT tgisinternal LIMIT 1`
  )
  assert(!triggers.rowCount, 'Destination Auth hooks or triggers require review before import.')
  const policies = await execute(
    db,
    safeSql`SELECT 1 FROM pg_policies WHERE schemaname = 'storage' LIMIT 1`
  )
  assert(!policies.rowCount, 'Destination Storage policies require a blank project.')
  const users = await execute(
    db,
    safeSql`SELECT id FROM auth.users WHERE $1::text IS NULL OR raw_app_meta_data->>'instant_import_owner' IS DISTINCT FROM $1 LIMIT 1`,
    [owner ?? null]
  )
  assert(!users.rowCount, 'Destination Auth contains conflicting users. Use a blank project.')
  const buckets = await execute(
    db,
    safeSql`SELECT id FROM storage.buckets WHERE $1::text IS NULL OR id <> $1 LIMIT 1`,
    [owner ? `instant-${owner}` : null]
  )
  assert(
    !buckets.rowCount,
    'Destination Storage contains conflicting buckets. Use a blank project.'
  )
}

export async function loadDatabase(db: Client, plan: Plan, schema: string): Promise<Job> {
  const owner = randomUUID()
  await execute(db, safeSql`BEGIN ISOLATION LEVEL READ COMMITTED`)
  try {
    const migration = migrationFor(plan, await prepareMigrationHistory(db))
    for (const statement of buildImportStateSchema(schema)) await execute(db, statement)
    for (const statement of migration.statements) await execute(db, statement)
    await execute(
      db,
      safeSql`INSERT INTO ${qualified(schema, 'restore_job')} (content_hash, version, owner, state, config, bucket, migration_version) VALUES ($1, $2, $3, 'restoring', $4, $5, $6)`,
      [plan.contentHash, plan.version, owner, plan.config, `instant-${owner}`, migration.version]
    )
    for (const ns of plan.namespaces) {
      for (let offset = 0; offset < ns.rows.length; offset += 100) {
        const batch = ns.rows.slice(offset, offset + 100)
        const provenance = batch.map((row) => [
          ns.source,
          row.id,
          row.createdAt,
          row.raw.toString('hex'),
          row.present,
        ])
        await execute(
          db,
          safeSql`INSERT INTO ${qualified(schema, 'provenance')} (table_name,id,source_created_at,source_record,source_presence) SELECT r->>0,(r->>1)::uuid,(r->>2)::bigint,decode(r->>3,'hex'),ARRAY(SELECT jsonb_array_elements_text(r->4)) FROM jsonb_array_elements($1::jsonb) r`,
          [JSON.stringify(provenance)]
        )
      }
    }
    for (const file of plan.files)
      await execute(
        db,
        safeSql`INSERT INTO ${qualified(schema, 'file_registry')} (source_id, object_key, logical_path, size, sha256, content_type) VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          file.id,
          file.key,
          Buffer.from(JSON.stringify(file.path)),
          file.size,
          file.hash,
          file.contentType,
        ]
      )
    for (const user of plan.namespaces.find((ns) => ns.source === '$users')?.rows ?? []) {
      const email =
        user.values.type !== 'guest' && typeof user.values.email === 'string'
          ? user.values.email
          : null
      await execute(
        db,
        safeSql`INSERT INTO ${qualified(schema, 'auth_map')} (source_id, state, email) VALUES ($1,$2,$3)`,
        [user.id, email ? 'pending' : 'logical_only', email]
      )
    }
    await recordMigration(db, migration)
    await execute(
      db,
      safeSql`UPDATE ${qualified(schema, 'restore_job')} SET schema_hash = $1 WHERE id`,
      [await fingerprint(db, schema)]
    )
    await execute(db, safeSql`COMMIT`)
  } catch (error) {
    // A dead connection makes ROLLBACK fail; never let that replace the real error.
    await execute(db, safeSql`ROLLBACK`).catch(() => {})
    throw error
  }
  return (await execute(db, safeSql`SELECT * FROM ${qualified(schema, 'restore_job')}`)).rows[0]
}

async function storageMappings(db: Client, schema: string): Promise<Map<string, string>> {
  const result = await execute(
    db,
    safeSql`SELECT source_id,storage_id FROM ${qualified(schema, 'file_registry')} WHERE storage_id IS NOT NULL`
  )
  return new Map(result.rows.map((r) => [r.source_id, r.storage_id]))
}
function mappedEdges(
  plan: Plan,
  link: Plan['links'][number],
  storageIds: Map<string, string>
): [string, string][] {
  const storage = new Set(
    plan.namespaces.filter((ns) => ns.destination === 'storage').map((ns) => ns.source)
  )
  const mapped = (source: string, id: string) => {
    if (!storage.has(source)) return id
    const target = storageIds.get(id)
    assert(target, 'Storage mapping verification failed: missing object ID')
    return target
  }
  return link.edges
    .map(([a, b]): [string, string] => [mapped(link.forward.on, a), mapped(link.reverse.on, b)])
    .sort((a, b) => byCodeUnit(a.join(), b.join()))
}

/** Native services must exist before application rows can satisfy their foreign keys. */
export async function loadApplicationData(db: Client, plan: Plan, schema: string) {
  const storageIds = await storageMappings(db, schema)
  await execute(db, safeSql`BEGIN ISOLATION LEVEL READ COMMITTED`)
  try {
    for (const ns of applicationNamespaces(plan)) {
      const foreignKeys = foreignKeysFor(plan, ns.target).map((fk) => ({
        ...fk,
        values: new Map(
          mappedEdges(plan, fk.link, storageIds).map(([source, target]) =>
            fk.owner === 'forward' ? [source, target] : [target, source]
          )
        ),
      }))
      const names = [
        ident('id'),
        ...(ns.source === '$users'
          ? [ident('auth_user_id')]
          : ns.source === '$files'
            ? [ident('storage_object_id')]
            : []),
        ...ns.columns.map((c) => ident(c.target)),
        ...foreignKeys.map((fk) => ident(fk.column)),
      ]
      const rows = applicationRows(plan, ns)
      const nativeColumn = ns.source === '$users' || ns.source === '$files'
      for (let offset = 0; offset < rows.length; offset += 100) {
        const batch = rows.slice(offset, offset + 100)
        const records = batch.map((row) => [
          row.id,
          ...(ns.source === '$users'
            ? [hasAuthIdentity(row) ? row.id : null]
            : ns.source === '$files'
              ? [storageIds.get(row.id)]
              : []),
          ...ns.columns.map((c) => {
            const value = valueForSql(row.values[c.source], c)
            return Buffer.isBuffer(value) ? `\\x${value.toString('hex')}` : value
          }),
          ...foreignKeys.map((fk) => fk.values.get(row.id) ?? null),
        ])
        const expressions = [
          safeSql`(r->>0)::uuid`,
          ...(nativeColumn ? [safeSql`(r->>1)::uuid`] : []),
          ...ns.columns.map(
            (c, i) =>
              safeSql`(r->>${literal(i + 1 + Number(nativeColumn))})::${sqlTypes[c.storage]}`
          ),
          ...foreignKeys.map(
            (_, i) =>
              safeSql`(r->>${literal(i + 1 + ns.columns.length + Number(nativeColumn))})::uuid`
          ),
        ]
        await execute(
          db,
          safeSql`INSERT INTO ${qualified('public', ns.target)} (${joinSqlFragments(names, ', ')}) SELECT ${joinSqlFragments(expressions, ', ')} FROM jsonb_array_elements($1::jsonb) AS r`,
          [JSON.stringify(records)]
        )
      }
    }
    for (const link of plan.links) {
      const m = link.mapping
      if (m.kind !== 'junction') continue
      const edges = mappedEdges(plan, link, storageIds)
      for (let offset = 0; offset < edges.length; offset += 1000)
        await execute(
          db,
          safeSql`INSERT INTO ${qualified('public', m.table)} (${ident(m.sourceColumn)},${ident(m.targetColumn)}) SELECT (r->>0)::uuid,(r->>1)::uuid FROM jsonb_array_elements($1::jsonb) r`,
          [JSON.stringify(edges.slice(offset, offset + 1000))]
        )
    }

    await execute(
      db,
      safeSql`UPDATE ${qualified(schema, 'restore_job')} SET data_loaded = true WHERE id`
    )
    await execute(db, safeSql`COMMIT`)
  } catch (error) {
    // A dead connection makes ROLLBACK fail; never let that replace the real error.
    await execute(db, safeSql`ROLLBACK`).catch(() => {})
    throw error
  }
}

export async function verifyDatabase(db: Client, plan: Plan, schema: string) {
  const settings = await execute(
    db,
    safeSql`SELECT config, schema_hash, data_loaded, migration_version FROM ${qualified(schema, 'restore_job')}`
  )
  assert(
    settings.rows[0].schema_hash === (await fingerprint(db, schema)),
    'Schema verification failed: destination drift'
  )
  assert(
    settings.rows[0].config.equals(plan.config),
    'Configuration verification failed: destination drift'
  )
  await verifyMigration(db, migrationFor(plan, settings.rows[0].migration_version))
  const loaded = settings.rows[0].data_loaded
  const storageIds = await storageMappings(db, schema)
  for (const ns of plan.namespaces) {
    const provenance = await execute(
      db,
      safeSql`SELECT * FROM ${qualified(schema, 'provenance')} WHERE table_name=$1 ORDER BY id`,
      [ns.source]
    )
    assert(
      provenance.rows.length === ns.rows.length,
      'Provenance count verification failed: destination drift'
    )
    for (const [i, row] of ns.rows.entries()) {
      assert(
        provenance.rows[i].id === row.id &&
          provenance.rows[i].source_record.equals(row.raw) &&
          Number(provenance.rows[i].source_created_at) === row.createdAt &&
          JSON.stringify(provenance.rows[i].source_presence) === JSON.stringify(row.present),
        'Row provenance verification failed: destination drift'
      )
    }
    if (ns.destination !== 'public') continue
    const result = await execute(
      db,
      safeSql`SELECT * FROM ${qualified('public', ns.target)} ORDER BY id`
    )
    const expected = loaded ? applicationRows(plan, ns) : []
    assert(
      result.rows.length === expected.length,
      'Row count verification failed: destination drift'
    )
    for (const [i, row] of expected.entries()) {
      const target = result.rows[i]
      assert(target.id === row.id, 'Row ID verification failed: destination drift')
      if (ns.source === '$users')
        assert(
          target.auth_user_id === (hasAuthIdentity(row) ? row.id : null),
          'Auth reference verification failed: destination drift'
        )
      if (ns.source === '$files')
        assert(
          target.storage_object_id === storageIds.get(row.id),
          'Storage reference verification failed: destination drift'
        )
      for (const column of ns.columns) {
        let value = target[column.target]
        if (column.storage === 'timestamptz' && value !== null) value = value.toISOString()
        if (column.storage === 'bytea' && value !== null) value = JSON.parse(value.toString('utf8'))
        assert(
          canonical(value) === canonical(row.values[column.source] ?? null),
          'Typed value verification failed: destination drift'
        )
      }
    }
  }
  const provenanceCount = await execute(
    db,
    safeSql`SELECT count(*) FROM ${qualified(schema, 'provenance')}`
  )
  assert(
    Number(provenanceCount.rows[0].count) === plan.sourceTotals.rows,
    'Provenance count verification failed: destination drift'
  )
  for (const link of plan.links) {
    const m = link.mapping
    const from =
      m.kind === 'junction'
        ? ident(m.sourceColumn)
        : m.owner === 'forward'
          ? ident('id')
          : ident(m.column)
    const to =
      m.kind === 'junction'
        ? ident(m.targetColumn)
        : m.owner === 'forward'
          ? ident(m.column)
          : ident('id')
    const result = await execute(
      db,
      safeSql`SELECT ${from} AS source_id, ${to} AS target_id FROM ${qualified('public', m.table)} WHERE ${from} IS NOT NULL AND ${to} IS NOT NULL ORDER BY source_id,target_id`
    )
    assert(
      JSON.stringify(result.rows.map((r) => [r.source_id, r.target_id])) ===
        JSON.stringify(loaded ? mappedEdges(plan, link, storageIds) : []),
      'Relationship verification failed: destination drift'
    )
  }
  const registry = await execute(
    db,
    safeSql`SELECT * FROM ${qualified(schema, 'file_registry')} ORDER BY source_id`
  )
  const files = [...plan.files].sort((a, b) => byCodeUnit(a.id, b.id))
  assert(
    registry.rows.length === files.length,
    'File registry verification failed: destination drift'
  )
  for (const [i, file] of files.entries()) {
    const record = registry.rows[i]
    assert(
      record.source_id === file.id &&
        record.object_key === file.key &&
        record.logical_path.equals(Buffer.from(JSON.stringify(file.path))) &&
        Number(record.size) === file.size &&
        record.sha256 === file.hash &&
        record.content_type === file.contentType &&
        (record.verified ? typeof record.storage_id === 'string' : record.storage_id === null) &&
        (!loaded || record.verified),
      'File registry verification failed: destination drift'
    )
  }
  const mappings = await execute(
    db,
    safeSql`SELECT * FROM ${qualified(schema, 'auth_map')} ORDER BY source_id`
  )
  const users = plan.namespaces.find((ns) => ns.source === '$users')?.rows ?? []
  assert(
    mappings.rows.length === users.length,
    'Auth mapping verification failed: destination drift'
  )
  for (const [i, user] of users.entries()) {
    const m = mappings.rows[i]
    const email =
      user.values.type !== 'guest' && typeof user.values.email === 'string'
        ? user.values.email
        : null
    assert(
      m.source_id === user.id &&
        m.email === email &&
        (email
          ? (loaded
              ? m.state === 'unconfirmed' && m.auth_id === user.id
              : ['pending', 'unconfirmed'].includes(m.state)) &&
            (m.auth_id === null || m.auth_id === user.id)
          : m.state === 'logical_only' && m.auth_id === null),
      'Auth mapping verification failed: destination drift'
    )
  }
  const access = await execute(
    db,
    safeSql`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE (n.nspname = $1 OR (n.nspname='public' AND c.relname = ANY($2::text[]))) AND c.relkind IN ('r','p') AND (NOT c.relrowsecurity OR has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE'))`,
    [schema, publicTables(plan)]
  )
  const helpers = await execute(
    db,
    safeSql`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))`,
    [schema]
  )
  const grants = await execute(
    db,
    safeSql`SELECT has_schema_privilege('anon', $1, 'USAGE') OR has_schema_privilege('authenticated', $1, 'USAGE') AS exposed`,
    [schema]
  )
  assert(
    !access.rowCount && !helpers.rowCount && !grants.rows[0].exposed,
    'Access verification failed: destination drift'
  )
}

async function fingerprint(db: Client, schema: string) {
  return hash(
    JSON.stringify([await schemaFingerprint(db, schema), await schemaFingerprint(db, 'public')])
  )
}
