import { ident, joinSqlFragments, literal, safeSql, type SafeSqlFragment } from '@supabase/pg-meta'
import { Client } from 'pg'

import { preflight } from '../import/database'
import { schemaFingerprint } from '../import/fingerprint'
import { hash } from '../import/input'
import { canonical } from '../import/json'
import { prepareMigrationHistory, recordMigration } from '../import/migrations'
import { hasAuthIdentity } from '../import/native'
import type { Target } from '../import/restore'
import { qualified } from '../import/sql'
import type { Column, Plan } from '../import/types'
import {
  credentialConnectMarginMs,
  DatabaseCredentialExpiredError,
  targetConnectTimeoutMs,
} from './credential-lease'
import { decodeRow, rowPage } from './staging'
import { advance, type Job } from './store'
import { supabaseDatabaseCa } from './supabase-ca'
import { finalConstraints, initialApplicationSchema, initialSchema } from './target-schema'

export function resolveTarget(ref: string): Target {
  // Trusted operator registry. OAuth connection references can replace this adapter later.
  const registry = JSON.parse(process.env.IMPORT_TARGETS_JSON ?? '{}')
  if (!Object.hasOwn(registry, ref)) throw new Error('Target credential reference is unavailable')
  const value = registry[ref]
  if (!value.databaseUrl || !value.supabaseUrl || !value.serviceRoleKey)
    throw new Error('Target credential reference is incomplete')
  return value
}
export const targetSchema = (plan: Plan) => `instant_workflow_${plan.contentHash.slice(0, 32)}`
export function targetConnectionOptions(target: Target) {
  if (!target.databaseRole) return { connectionString: target.databaseUrl }
  const url = new URL(target.databaseUrl)
  return {
    host: url.hostname,
    port: Number(url.port),
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: { ca: supabaseDatabaseCa, rejectUnauthorized: true },
  }
}
export async function targetConnection(target: Target) {
  if (
    target.databaseRole &&
    (!target.databaseExpiresAt ||
      target.databaseExpiresAt <= Date.now() + credentialConnectMarginMs)
  )
    throw new DatabaseCredentialExpiredError()
  const db = new Client({
    ...targetConnectionOptions(target),
    connectionTimeoutMillis: targetConnectTimeoutMs,
    query_timeout: 120_000,
  })
  try {
    await db.connect()
    if (target.databaseRole === 'postgres') await db.query(safeSql`SET ROLE postgres`)
    await db.query(safeSql`SET extra_float_digits=3`)
    if (
      !(await db.query(safeSql`SELECT pg_try_advisory_lock(1735289201,1) AS acquired`)).rows[0]
        .acquired
    )
      throw new Error('Destination has an active writer')
    return db
  } catch (error) {
    await db.end()
    throw error
  }
}
export async function connectTargetWithRefresh(resolve: (force: boolean) => Promise<Target>) {
  let target = await resolve(false)
  try {
    return { target, db: await targetConnection(target) }
  } catch (error) {
    const rejected =
      error instanceof DatabaseCredentialExpiredError ||
      (error instanceof Error &&
        (('code' in error && error.code === '28P01') ||
          /^SASL: SCRAM-SERVER-FINAL-MESSAGE: (server signature is missing|server signature does not match)$/.test(
            error.message
          )))
    // Renew an expired lease or rotated CLI password once, before destination work starts.
    if (!target.databaseRole || !rejected) throw error
    target = await resolve(true)
    return { target, db: await targetConnection(target) }
  }
}
export async function fingerprint(db: Client, schema: string) {
  const definitions = [await schemaFingerprint(db, schema), await schemaFingerprint(db, 'public')]
  return hash(JSON.stringify(definitions))
}
export async function assertOwner(db: Client, job: Job, plan: Plan) {
  const state = (
    await db.query(
      safeSql`SELECT owner,content_hash,schema_hash FROM ${qualified(targetSchema(plan), 'restore_job')}`
    )
  ).rows[0]
  if (
    state?.owner !== job.id ||
    state.content_hash !== plan.contentHash ||
    state.schema_hash !== (await fingerprint(db, targetSchema(plan)))
  )
    throw new Error('Destination ownership or schema drift')
}
/** Target mutation + idempotency receipt commit together; service progress commits afterward. */
export async function targetBatch(
  db: Client,
  job: Job,
  plan: Plan,
  work: () => Promise<void>,
  ddl = false
) {
  const schema = targetSchema(plan),
    checksum = hash(JSON.stringify([plan.contentHash, job.phase, job.cursor]))
  await db.query(safeSql`BEGIN`)
  try {
    const old = (
      await db.query(
        safeSql`SELECT checksum FROM ${qualified(schema, 'workflow_batches')} WHERE step=$1`,
        [job.revision]
      )
    ).rows[0]
    if (old) {
      if (old.checksum !== checksum) throw new Error('Batch receipt conflict')
    } else {
      await work()
      await db.query(
        safeSql`INSERT INTO ${qualified(schema, 'workflow_batches')}(step,checksum) VALUES($1,$2)`,
        [job.revision, checksum]
      )
      if (ddl)
        await db.query(
          safeSql`UPDATE ${qualified(schema, 'restore_job')} SET schema_hash=$1 WHERE id`,
          [await fingerprint(db, schema)]
        )
    }
    await db.query(safeSql`COMMIT`)
  } catch (error) {
    await db.query(safeSql`ROLLBACK`)
    throw error
  }
}
export async function createTarget(service: Client, db: Client, job: Job, plan: Plan) {
  const schema = targetSchema(plan)
  const exists = (await db.query(safeSql`SELECT 1 FROM pg_namespace WHERE nspname=$1`, [schema]))
    .rowCount
  if (exists) await assertOwner(db, job, plan)
  else {
    await preflight(db, schema)
    await db.query(safeSql`BEGIN`)
    try {
      const version = await prepareMigrationHistory(db),
        name = `import_schema_${plan.contentHash.slice(0, 12)}`,
        statements = initialSchema(plan, schema)
      for (const sql of statements) await db.query(sql)
      await db.query(
        safeSql`INSERT INTO ${qualified(schema, 'restore_job')}(content_hash,version,owner,state,config,bucket,migration_version) VALUES($1,4,$2,'workflow_restoring',$3,$4,$5)`,
        [plan.contentHash, job.id, job.config, `instant-${job.id}`, version]
      )
      await recordMigration(db, {
        version,
        name,
        fileName: `${version}_${name}.sql`,
        statements: initialApplicationSchema(plan),
      })
      await db.query(
        safeSql`UPDATE ${qualified(schema, 'restore_job')} SET schema_hash=$1 WHERE id`,
        [await fingerprint(db, schema)]
      )
      await db.query(safeSql`COMMIT`)
    } catch (error) {
      await db.query(safeSql`ROLLBACK`)
      throw error
    }
  }
  await advance(service, job, 'auth')
}
const types: Record<Column['storage'], SafeSqlFragment> = {
  text: safeSql`text`,
  'double precision': safeSql`double precision`,
  boolean: safeSql`boolean`,
  timestamptz: safeSql`timestamptz`,
  jsonb: safeSql`jsonb`,
  bytea: safeSql`bytea`,
}
export async function importRows(
  service: Client,
  db: Client,
  job: Job,
  plan: Plan,
  verify = false
) {
  const ns = plan.namespaces[job.cursor.index],
    schema = targetSchema(plan)
  if (!ns) {
    await advance(service, job, verify ? 'reports' : 'links')
    return
  }
  const staged = await rowPage(service, job.id, ns.source, job.cursor.after)
  if (!staged.length) {
    if (verify) {
      const expected = Number(
        (
          await service.query(
            safeSql`SELECT count(*) AS n FROM instant_import_service.rows WHERE job_id=$1 AND namespace=$2`,
            [job.id, ns.source]
          )
        ).rows[0].n
      )
      const actual = Number(
        (
          await db.query(
            safeSql`SELECT count(*) AS n FROM ${qualified(schema, 'provenance')} WHERE table_name=$1`,
            [ns.source]
          )
        ).rows[0].n
      )
      if (expected !== actual) throw new Error('Provenance count drift')
      if (ns.destination === 'public') {
        const included =
          ns.source === '$files'
            ? Number(
                (
                  await service.query(
                    safeSql`SELECT count(*) AS n FROM instant_import_service.blobs WHERE job_id=$1 AND included`,
                    [job.id]
                  )
                ).rows[0].n
              )
            : expected
        if (
          Number(
            (await db.query(safeSql`SELECT count(*) AS n FROM ${qualified('public', ns.target)}`))
              .rows[0].n
          ) !== included
        )
          throw new Error('Application row count drift')
      }
    }
    await advance(service, job, verify ? 'verifying' : 'rows', {
      index: job.cursor.index + 1,
      after: '',
      offset: 0,
    })
    return
  }
  const all = staged.map(decodeRow),
    rows: Plan['namespaces'][number]['rows'] = []
  for (const row of all) {
    if (
      ns.source === '$files' &&
      !(
        await service.query(
          safeSql`SELECT 1 FROM instant_import_service.blobs WHERE job_id=$1 AND id=$2 AND included`,
          [job.id, row.id]
        )
      ).rowCount
    )
      continue
    rows.push(row)
  }
  const native = ns.source === '$users' || ns.source === '$files'
  const storageIds = new Map<string, string>(
    (
      await db.query(
        safeSql`SELECT source_id,storage_id FROM ${qualified(schema, 'file_registry')} WHERE source_id=ANY($1::uuid[])`,
        [rows.map((r) => r.id)]
      )
    ).rows.map((r) => [r.source_id, r.storage_id])
  )
  if (verify) {
    const provenance = (
      await db.query(
        safeSql`SELECT id,source_record,source_created_at,source_presence FROM ${qualified(schema, 'provenance')} WHERE table_name=$1 AND id=ANY($2::uuid[])`,
        [ns.source, all.map((r) => r.id)]
      )
    ).rows
    if (
      provenance.length !== all.length ||
      provenance.some((p) => {
        const row = all.find((r) => r.id === p.id)!
        return (
          !p.source_record.equals(row.raw) ||
          Number(p.source_created_at) !== row.createdAt ||
          canonical(p.source_presence) !== canonical(row.present)
        )
      })
    )
      throw new Error('Provenance bytes drift')
    if (ns.source === '$users') {
      const identities = (
        await db.query(
          safeSql`SELECT m.source_id,m.state,m.auth_id,u.email,u.email_confirmed_at,u.raw_app_meta_data FROM ${qualified(schema, 'auth_map')} m LEFT JOIN auth.users u ON u.id=m.auth_id WHERE m.source_id=ANY($1::uuid[])`,
          [rows.map((r) => r.id)]
        )
      ).rows
      if (identities.length !== rows.length) throw new Error('Auth mapping count drift')
      for (const identity of identities) {
        const row = rows.find((r) => r.id === identity.source_id)!
        if (
          hasAuthIdentity(row)
            ? identity.auth_id !== row.id ||
              identity.state !== 'unconfirmed' ||
              identity.email?.toLowerCase() !== String(row.values.email).toLowerCase() ||
              identity.email_confirmed_at ||
              identity.raw_app_meta_data?.instant_import_owner !== job.id
            : identity.auth_id !== null || identity.state !== 'logical_only'
        )
          throw new Error('Auth identity drift')
      }
    }
    if (ns.source === '$files') {
      const expected = (
        await service.query(
          safeSql`SELECT id,storage_id,storage_version FROM instant_import_service.transfers WHERE job_id=$1 AND id=ANY($2::uuid[])`,
          [job.id, rows.map((r) => r.id)]
        )
      ).rows
      const actual = (
        await db.query(
          safeSql`SELECT f.source_id,f.storage_id,o.version,o.bucket_id,o.name,o.metadata FROM ${qualified(schema, 'file_registry')} f LEFT JOIN storage.objects o ON o.id=f.storage_id WHERE f.source_id=ANY($1::uuid[])`,
          [rows.map((r) => r.id)]
        )
      ).rows
      if (expected.length !== rows.length || actual.length !== rows.length)
        throw new Error('Storage mapping count drift')
      for (const object of actual) {
        const verified = expected.find((r) => r.id === object.source_id)!
        if (
          !verified ||
          object.storage_id !== verified.storage_id ||
          object.version !== verified.storage_version ||
          object.bucket_id !== `instant-${job.id}` ||
          object.name !== object.source_id
        )
          throw new Error('Storage object changed after verification')
      }
    }
    if (ns.destination === 'public') {
      const data = (
        await db.query(
          safeSql`SELECT * FROM ${qualified('public', ns.target)} WHERE id=ANY($1::uuid[])`,
          [rows.map((r) => r.id)]
        )
      ).rows
      if (data.length !== rows.length) throw new Error('Application row missing')
      for (const actual of data) {
        const expected = rows.find((r) => r.id === actual.id)!
        for (const c of ns.columns) {
          let value = actual[c.target]
          if (value !== null && c.storage === 'timestamptz') value = value.toISOString()
          if (value !== null && c.storage === 'bytea') value = JSON.parse(value.toString())
          if (canonical(value) !== canonical(expected.values[c.source] ?? null))
            throw new Error('Application value drift')
        }
        if (
          ns.source === '$users' &&
          actual.auth_user_id !== (hasAuthIdentity(expected) ? expected.id : null)
        )
          throw new Error('Auth mapping drift')
        if (ns.source === '$files' && actual.storage_object_id !== storageIds.get(expected.id))
          throw new Error('Storage mapping drift')
      }
    }
  } else
    await targetBatch(db, job, plan, async () => {
      await db.query(
        safeSql`INSERT INTO ${qualified(schema, 'provenance')}(table_name,id,source_created_at,source_record,source_presence) SELECT $1,(r->>0)::uuid,(r->>1)::bigint,decode(r->>2,'hex'),ARRAY(SELECT jsonb_array_elements_text(r->3)) FROM jsonb_array_elements($2::jsonb) r`,
        [
          ns.source,
          JSON.stringify(all.map((r) => [r.id, r.createdAt, r.raw.toString('hex'), r.present])),
        ]
      )
      if (ns.destination !== 'public' || !rows.length) return
      const columns = [
        ident('id'),
        ...(native ? [ident(ns.source === '$users' ? 'auth_user_id' : 'storage_object_id')] : []),
        ...ns.columns.map((c) => ident(c.target)),
      ]
      const values = rows.map((row) => [
        row.id,
        ...(native
          ? [
              ns.source === '$users'
                ? hasAuthIdentity(row)
                  ? row.id
                  : null
                : storageIds.get(row.id),
            ]
          : []),
        ...ns.columns.map((c) => {
          const v = row.values[c.source]
          return v === undefined || v === null
            ? null
            : c.storage === 'bytea'
              ? `\\x${Buffer.from(canonical(v)).toString('hex')}`
              : c.storage === 'jsonb'
                ? canonical(v)
                : v
        }),
      ])
      const expressions = [
        safeSql`(r->>0)::uuid`,
        ...(native ? [safeSql`(r->>1)::uuid`] : []),
        ...ns.columns.map(
          (c, i) => safeSql`(r->>${literal(i + 1 + Number(native))})::${types[c.storage]}`
        ),
      ]
      await db.query(
        safeSql`INSERT INTO ${qualified('public', ns.target)}(${joinSqlFragments(columns, ',')}) SELECT ${joinSqlFragments(expressions, ',')} FROM jsonb_array_elements($1::jsonb) r`,
        [JSON.stringify(values)]
      )
    })
  await advance(service, job, verify ? 'verifying' : 'rows', {
    ...job.cursor,
    after: staged.at(-1)!.id,
  })
}
export async function importLinks(
  service: Client,
  db: Client,
  job: Job,
  plan: Plan,
  verify = false
) {
  const link = plan.links[job.cursor.index],
    schema = targetSchema(plan)
  if (!link) {
    await advance(service, job, verify ? 'verifying' : 'constraints')
    return
  }
  const cursor = job.cursor.after ? JSON.parse(job.cursor.after) : null
  const edges = (
    await service.query(
      safeSql`SELECT source_id,target_id FROM instant_import_service.edges WHERE job_id=$1 AND link=$2 AND ($3::uuid IS NULL OR (source_id,target_id)>($3::uuid,$4::uuid)) ORDER BY source_id,target_id LIMIT 1000`,
      [job.id, link.source, cursor?.[0] ?? null, cursor?.[1] ?? null]
    )
  ).rows
  if (!edges.length) {
    if (verify) {
      const m = link.mapping
      const actual = Number(
        (
          await db.query(
            m.kind === 'junction'
              ? safeSql`SELECT count(*) AS n FROM ${qualified('public', m.table)}`
              : safeSql`SELECT count(*) AS n FROM ${qualified('public', m.table)} WHERE ${ident(m.column)} IS NOT NULL`
          )
        ).rows[0].n
      )
      const expected = Number(
        (
          await service.query(
            safeSql`SELECT count(*) AS n FROM instant_import_service.edges WHERE job_id=$1 AND link=$2`,
            [job.id, link.source]
          )
        ).rows[0].n
      )
      if (actual !== expected) throw new Error('Relationship count drift')
    }
    await advance(service, job, verify ? ('verify_links' as Job['phase']) : 'links', {
      index: job.cursor.index + 1,
      after: '',
      offset: 0,
    })
    return
  }
  const sources = new Map(plan.namespaces.map((n) => [n.source, n.destination]))
  const ids = (
    await db.query(
      safeSql`SELECT source_id,storage_id FROM ${qualified(schema, 'file_registry')} WHERE source_id=ANY($1::uuid[])`,
      [edges.flatMap((e) => [e.source_id, e.target_id])]
    )
  ).rows
  const mapped = edges.map((e) => [
    sources.get(link.forward.on) === 'storage'
      ? ids.find((f) => f.source_id === e.source_id)?.storage_id
      : e.source_id,
    sources.get(link.reverse.on) === 'storage'
      ? ids.find((f) => f.source_id === e.target_id)?.storage_id
      : e.target_id,
  ])
  if (mapped.some((e) => e.some((id) => !id))) throw new Error('Missing native link mapping')
  const m = link.mapping,
    table = qualified('public', m.table)
  if (verify) {
    const source =
        m.kind === 'junction'
          ? ident(m.sourceColumn)
          : m.owner === 'forward'
            ? ident('id')
            : ident(m.column),
      target =
        m.kind === 'junction'
          ? ident(m.targetColumn)
          : m.owner === 'forward'
            ? ident(m.column)
            : ident('id')
    const count = (
      await db.query(
        safeSql`SELECT count(*) AS n FROM jsonb_array_elements($1::jsonb) r WHERE EXISTS(SELECT 1 FROM ${table} WHERE ${source}=(r->>0)::uuid AND ${target}=(r->>1)::uuid)`,
        [JSON.stringify(mapped)]
      )
    ).rows[0].n
    if (Number(count) !== mapped.length) throw new Error('Relationship value drift')
  } else
    await targetBatch(db, job, plan, async () => {
      if (m.kind === 'junction')
        await db.query(
          safeSql`INSERT INTO ${table}(${ident(m.sourceColumn)},${ident(m.targetColumn)}) SELECT (r->>0)::uuid,(r->>1)::uuid FROM jsonb_array_elements($1::jsonb) r`,
          [JSON.stringify(mapped)]
        )
      else
        await db.query(
          safeSql`UPDATE ${table} AS t SET ${ident(m.column)}=(r->>${literal(m.owner === 'forward' ? 1 : 0)})::uuid FROM jsonb_array_elements($1::jsonb) r WHERE t.id=(r->>${literal(m.owner === 'forward' ? 0 : 1)})::uuid`,
          [JSON.stringify(mapped)]
        )
    })
  await advance(service, job, verify ? ('verify_links' as Job['phase']) : 'links', {
    ...job.cursor,
    after: JSON.stringify([edges.at(-1)!.source_id, edges.at(-1)!.target_id]),
  })
}
export async function constrain(service: Client, db: Client, job: Job, plan: Plan) {
  const statements = finalConstraints(plan),
    statement = statements[job.cursor.index]
  if (!statement) {
    await advance(service, job, 'verify_links' as Job['phase'])
    return
  }
  await targetBatch(
    db,
    job,
    plan,
    async () => {
      await db.query(statement)
      const version = await prepareMigrationHistory(db),
        name = `import_constraints_${plan.contentHash.slice(0, 12)}_${job.cursor.index}`
      await recordMigration(db, {
        version,
        name,
        fileName: `${version}_${name}.sql`,
        statements: [statement],
      })
    },
    true
  )
  await advance(service, job, 'constraints', { index: job.cursor.index + 1, after: '', offset: 0 })
}
