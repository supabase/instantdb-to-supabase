import { safeSql, type SafeSqlFragment } from '@supabase/pg-meta'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { Client } from 'pg'

import { loadApplicationData, loadDatabase, preflight, verifyDatabase, type Job } from './database'
import { hash } from './input'
import { canonical } from './json'
import { migrationFor, type SchemaMigration } from './migrations'
import { storageMetadata } from './native'
import { publicTables } from './relational'
import { qualified, removeImportState } from './sql'
import type { Plan } from './types'

export type Target = {
  databaseUrl: string
  supabaseUrl: string
  serviceRoleKey: string
  databaseRole?: 'postgres'
  databaseExpiresAt?: number
}
export type Checkpoint =
  | 'database_committed'
  | 'application_committed'
  | 'bucket_planned'
  | 'bucket_created'
  | 'auth_created'
  | 'file_uploaded'
  | 'verified'
export type RestoreOptions = {
  schema?: string
  /** Diagnostic opt-in; normal completed imports remove their temporary state. */
  retainImportState?: boolean
  onCheckpoint?: (point: Checkpoint) => void | Promise<void>
}
export type Report = {
  state: 'restored_setup_required'
  schema: 'public'
  metadataSchema: string | null
  migration: Pick<SchemaMigration, 'name' | 'version' | 'fileName'>
  bucket: string | null
  contentHash: string
  revision: number
  sourceTotals: Plan['totals']
  verified: Plan['totals']
  setup: Plan['diagnostics']
}

const execute = (db: Client, sql: SafeSqlFragment, values?: unknown[]) => db.query(sql, values)
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function restoreAuth(
  db: Client,
  api: SupabaseClient,
  schema: string,
  job: Job,
  options: RestoreOptions
) {
  const mappings = await execute(
    db,
    safeSql`SELECT * FROM ${qualified(schema, 'auth_map')} ORDER BY source_id`
  )
  for (const mapping of mappings.rows) {
    if (mapping.state === 'logical_only') continue
    const lookup = await api.auth.admin.getUserById(mapping.source_id)
    if (lookup.error && lookup.error.status !== 404)
      throw new Error('Auth lookup failed. Check destination credentials and retry.')
    let user = lookup.data.user
    if (!user) {
      assert(mapping.state === 'pending', 'Auth verification failed: imported user is missing')
      const result = await api.auth.admin.createUser({
        id: mapping.source_id,
        email: mapping.email,
        email_confirm: false,
        app_metadata: { instant_import_owner: job.owner },
      })
      if (result.error)
        throw new Error(
          'Auth creation failed. Check for identity conflicts and retry; existing accounts are never linked.'
        )
      user = result.data.user
      await options.onCheckpoint?.('auth_created')
    }
    assert(
      user &&
        user.id === mapping.source_id &&
        user.email?.toLowerCase() === mapping.email.toLowerCase() &&
        user.app_metadata.instant_import_owner === job.owner &&
        !user.email_confirmed_at,
      'Auth verification failed: identity conflict or destination drift'
    )
    // Check that SQL and the service API refer to the same destination project.
    const backing = await execute(
      db,
      safeSql`SELECT id FROM auth.users WHERE id = $1 AND raw_app_meta_data->>'instant_import_owner' = $2`,
      [user.id, job.owner]
    )
    assert(backing.rowCount === 1, 'Destination mismatch between SQL and Auth API')
    await execute(
      db,
      safeSql`UPDATE ${qualified(schema, 'auth_map')} SET state = 'unconfirmed', auth_id = $1 WHERE source_id = $1`,
      [mapping.source_id]
    )
  }
}

async function restoreFiles(
  db: Client,
  api: SupabaseClient,
  plan: Plan,
  schema: string,
  job: Job,
  options: RestoreOptions
) {
  if (!plan.files.length) return
  let bucket = await api.storage.getBucket(job.bucket)
  if (bucket.error && !['404', '400'].includes(String(bucket.error.statusCode)))
    throw new Error('Storage lookup failed. Check destination credentials and retry.')
  if (!bucket.data) {
    assert(!job.bucket_ready, 'Storage bucket verification failed: destination drift')
    await execute(
      db,
      safeSql`UPDATE ${qualified(schema, 'restore_job')} SET bucket_started = true WHERE id`
    )
    job.bucket_started = true
    await options.onCheckpoint?.('bucket_planned')
    const created = await api.storage.createBucket(job.bucket, { public: false })
    if (created.error)
      throw new Error('Storage bucket creation failed. Inspect the job bucket and resume.')
    await execute(
      db,
      safeSql`UPDATE ${qualified(schema, 'restore_job')} SET bucket_ready = true WHERE id`
    )
    await options.onCheckpoint?.('bucket_created')
    bucket = await api.storage.getBucket(job.bucket)
  }
  assert(
    job.bucket_started && bucket.data && !bucket.data.public,
    'Storage bucket conflict or destination drift'
  )
  const backing = await execute(
    db,
    safeSql`SELECT id FROM storage.buckets WHERE id = $1 AND public = false`,
    [job.bucket]
  )
  assert(backing.rowCount === 1, 'Destination mismatch between SQL and Storage API')
  await execute(
    db,
    safeSql`UPDATE ${qualified(schema, 'restore_job')} SET bucket_ready = true WHERE id`
  )
  const byKey = new Map(plan.files.map((file) => [file.key, file]))
  for (const file of byKey.values()) {
    let downloaded = await api.storage.from(job.bucket).download(file.key)
    if (downloaded.error) {
      const exists = await execute(
        db,
        safeSql`SELECT id FROM storage.objects WHERE bucket_id = $1 AND name = $2`,
        [job.bucket, file.key]
      )
      const verified = await execute(
        db,
        safeSql`SELECT 1 FROM ${qualified(schema, 'file_registry')} WHERE object_key = $1 AND verified`,
        [file.key]
      )
      assert(
        !exists.rowCount &&
          !verified.rowCount &&
          ['400', '404'].includes(String(downloaded.error.statusCode)),
        'Storage download failed or destination object drift'
      )
      const uploaded = await api.storage.from(job.bucket).upload(file.key, file.bytes, {
        contentType: file.contentType,
        metadata: storageMetadata(file),
        upsert: false,
      })
      if (uploaded.error)
        throw new Error('Storage upload failed. Resume to reconcile the uploaded object.')
      await options.onCheckpoint?.('file_uploaded')
      downloaded = await api.storage.from(job.bucket).download(file.key)
    }
    assert(!downloaded.error && downloaded.data, 'Storage read-back verification failed')
    const bytes = Buffer.from(await downloaded.data.arrayBuffer())
    assert(
      bytes.length === file.size && hash(bytes) === file.hash,
      'File hash verification failed: destination drift'
    )
    const metadata = await execute(
      db,
      safeSql`SELECT id, metadata, user_metadata FROM storage.objects WHERE bucket_id = $1 AND name = $2`,
      [job.bucket, file.key]
    )
    assert(
      metadata.rowCount === 1 &&
        metadata.rows[0].metadata?.mimetype === file.contentType &&
        Number(metadata.rows[0].metadata?.size) === file.size &&
        canonical(metadata.rows[0].user_metadata) === canonical(storageMetadata(file)),
      'File metadata verification failed'
    )
    const registry = await execute(
      db,
      safeSql`SELECT storage_id FROM ${qualified(schema, 'file_registry')} WHERE object_key = $1`,
      [file.key]
    )
    assert(
      registry.rows.every((r) => r.storage_id === null || r.storage_id === metadata.rows[0].id),
      'Storage object identity verification failed: destination drift'
    )
    await execute(
      db,
      safeSql`UPDATE ${qualified(schema, 'file_registry')} SET verified = true, storage_id = $2 WHERE object_key = $1`,
      [file.key, metadata.rows[0].id]
    )
  }
  const count = await execute(
    db,
    safeSql`SELECT count(*) FROM storage.objects WHERE bucket_id = $1`,
    [job.bucket]
  )
  assert(Number(count.rows[0].count) === byKey.size, 'Unexpected destination file: drift')
}

/**
 * The advisory lock and the explicit BEGIN/COMMIT blocks below need one session for
 * the whole restore, which a transaction pooler cannot provide.
 */
export function assertSessionConnection(databaseUrl: string) {
  const port = URL.canParse(databaseUrl) ? new URL(databaseUrl).port : ''
  assert(
    port !== '6543',
    'Use a direct or session-mode connection; transaction poolers (port 6543) are not supported.'
  )
}

/** Trusted Node worker entry point. Never expose database credentials through a route. */
export async function restore(
  plan: Plan,
  target: Target,
  options: RestoreOptions = {}
): Promise<Report> {
  const schema = options.schema ?? `instant_v3_${plan.contentHash.slice(0, 32)}`
  assert(/^instant_[a-z0-9_]{1,48}$/.test(schema), 'Invalid import schema')
  assertSessionConnection(target.databaseUrl)
  const db = new Client({
    connectionString: target.databaseUrl,
    connectionTimeoutMillis: 10_000,
    query_timeout: 120_000,
  })
  const api = createClient(target.supabaseUrl, target.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  await db.connect()
  try {
    await execute(db, safeSql`SET extra_float_digits = 3`)
    const lock = await execute(db, safeSql`SELECT pg_try_advisory_lock(1735289201, 1) AS acquired`)
    assert(
      lock.rows[0].acquired,
      'Another restore is running for this destination. Retry after it finishes.'
    )
    const existing = await execute(db, safeSql`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [
      schema,
    ])
    let job: Job
    if (existing.rowCount) {
      job = (await execute(db, safeSql`SELECT * FROM ${qualified(schema, 'restore_job')}`)).rows[0]
      assert(
        job?.content_hash === plan.contentHash &&
          job.version === plan.version &&
          job.bucket === `instant-${job.owner}`,
        'Restore ownership or version conflict'
      )
      await preflight(db, schema, job.owner, publicTables(plan))
      await verifyDatabase(db, plan, schema)
    } else {
      await preflight(db, schema)
      // Duplicate email detection must happen before any SQL mutation, including
      // case variants that the source's unique string semantics may allow.
      const emails = new Set<string>()
      for (const user of plan.namespaces.find((ns) => ns.source === '$users')?.rows ?? []) {
        if (user.values.type === 'guest' || typeof user.values.email !== 'string') continue
        const email = user.values.email.trim().toLowerCase()
        assert(
          email === user.values.email.toLowerCase() &&
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
            !emails.has(email),
          'Conflicting or unsupported Auth email in backup'
        )
        emails.add(email)
      }
      job = await loadDatabase(db, plan, schema)
      await options.onCheckpoint?.('database_committed')
    }
    await restoreAuth(db, api, schema, job, options)
    await restoreFiles(db, api, plan, schema, job, options)
    if (!job.data_loaded) {
      await loadApplicationData(db, plan, schema)
      await options.onCheckpoint?.('application_committed')
    }
    await verifyDatabase(db, plan, schema)
    await options.onCheckpoint?.('verified')
    const updated = await execute(
      db,
      safeSql`UPDATE ${qualified(schema, 'restore_job')} SET state = 'restored_setup_required', revision = revision + 1 WHERE id RETURNING revision`
    )
    const { name, version, fileName } = migrationFor(plan, job.migration_version)
    if (!options.retainImportState) {
      await execute(db, safeSql`BEGIN`)
      try {
        for (const statement of removeImportState(schema)) await execute(db, statement)
        await execute(db, safeSql`COMMIT`)
      } catch (error) {
        // A dead connection makes ROLLBACK fail; never let that replace the real error.
        await execute(db, safeSql`ROLLBACK`).catch(() => {})
        throw error
      }
    }
    return {
      migration: { name, version, fileName },
      state: 'restored_setup_required',
      schema: 'public',
      metadataSchema: options.retainImportState ? schema : null,
      bucket: plan.files.length ? job.bucket : null,
      contentHash: plan.contentHash,
      revision: Number(updated.rows[0].revision),
      sourceTotals: plan.sourceTotals,
      verified: plan.totals,
      setup: plan.diagnostics,
    }
  } finally {
    await db.end()
  }
}
