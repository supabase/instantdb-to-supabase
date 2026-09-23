import { safeSql } from '@supabase/pg-meta'
import { createClient } from '@supabase/supabase-js'
import { createSHA256 } from 'hash-wasm'
import type { Client } from 'pg'

import { canonical } from '../import/json'
import { hasAuthIdentity, storageMetadata } from '../import/native'
import type { Target } from '../import/restore'
import { qualified } from '../import/sql'
import type { FileRecord, Plan } from '../import/types'
import { storageSource } from './source'
import { decodeRow, rowPage } from './staging'
import { advance, connectStore, type Job, type SourceFile } from './store'
import { targetBatch, targetSchema } from './target'
import { createUpload, uploadChunk, uploadChunkBytes, uploadOffset } from './tus'

export async function importAuth(
  service: Client,
  db: Client,
  job: Job,
  plan: Plan,
  target: Target
) {
  const rows = (await rowPage(service, job.id, '$users', job.cursor.after)).slice(0, 5),
    schema = targetSchema(plan)
  if (!rows.length) {
    await advance(service, job, 'files')
    return
  }
  const api = createClient(target.supabaseUrl, target.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(20_000) }),
    },
  })
  const mappings: unknown[][] = []
  for (const staged of rows) {
    const row = decodeRow(staged)
    if (!hasAuthIdentity(row)) {
      mappings.push([row.id, 'logical_only', null, null])
      continue
    }
    const lookup = await api.auth.admin.getUserById(row.id)
    if (lookup.error && lookup.error.status !== 404)
      throw new Error(`Auth lookup failed (${lookup.error.status})`)
    let user = lookup.data.user
    if (!user) {
      const created = await api.auth.admin.createUser({
        id: row.id,
        email: String(row.values.email),
        email_confirm: false,
        app_metadata: { instant_import_owner: job.id },
      })
      if (created.error) throw new Error(`Auth creation failed (${created.error.status})`)
      user = created.data.user
    }
    if (
      !user ||
      user.id !== row.id ||
      user.app_metadata.instant_import_owner !== job.id ||
      user.email?.toLowerCase() !== String(row.values.email).toLowerCase() ||
      user.email_confirmed_at
    )
      throw new Error('Auth identity ownership conflict')
    if (
      !(
        await db.query(
          safeSql`SELECT 1 FROM auth.users WHERE id=$1 AND raw_app_meta_data->>'instant_import_owner'=$2`,
          [row.id, job.id]
        )
      ).rowCount
    )
      throw new Error('Auth API and SQL destination mismatch')
    mappings.push([row.id, 'unconfirmed', row.values.email, row.id])
  }
  await targetBatch(db, job, plan, async () => {
    await db.query(
      safeSql`INSERT INTO ${qualified(schema, 'auth_map')}(source_id,state,email,auth_id) SELECT (r->>0)::uuid,r->>1,r->>2,(r->>3)::uuid FROM jsonb_array_elements($1::jsonb) r`,
      [JSON.stringify(mappings)]
    )
  })
  await advance(service, job, 'auth', { ...job.cursor, after: rows.at(-1)!.id })
}
/**
 * Runs one statement on its own autocommit connection, outside the step's service transaction.
 * A resumable upload URL that a step rollback discards orphans the partial destination upload
 * and restarts the transfer from offset 0, so its ledger row has to outlive the step.
 */
async function recordTransfer(run: (store: Client) => Promise<unknown>) {
  const store = await connectStore()
  try {
    await run(store)
  } finally {
    await store.end()
  }
}
export async function importFile(
  service: Client,
  db: Client,
  job: Job,
  plan: Plan,
  target: Target
) {
  const blob = (
    await service.query(
      safeSql`SELECT b.id,b.metadata,f.* FROM instant_import_service.blobs b JOIN instant_import_service.files f ON f.job_id=b.job_id AND f.id=b.source_file WHERE b.job_id=$1 AND b.included AND ($2::uuid IS NULL OR b.id>$2::uuid) ORDER BY b.id LIMIT 1`,
      [job.id, job.cursor.after || null]
    )
  ).rows[0]
  if (!blob) {
    await advance(service, job, 'rows')
    return
  }
  const file = JSON.parse(blob.metadata.toString()) as Omit<FileRecord, 'bytes'>,
    bucket = `instant-${job.id}`,
    schema = targetSchema(plan)
  const api = createClient(target.supabaseUrl, target.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(20_000) }),
    },
  })
  const foundBucket = await api.storage.getBucket(bucket)
  if (foundBucket.error) {
    const created = await api.storage.createBucket(bucket, { public: false })
    if (created.error)
      throw new Error(`Storage bucket creation failed (${created.error.statusCode})`)
  } else if (foundBucket.data.public) throw new Error('Imported bucket is no longer private')
  let transfer = (
    await service.query(
      safeSql`SELECT * FROM instant_import_service.transfers WHERE job_id=$1 AND id=$2`,
      [job.id, file.id]
    )
  ).rows[0]
  if (!transfer) {
    await recordTransfer((store) =>
      store.query(
        safeSql`INSERT INTO instant_import_service.transfers(job_id,id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [job.id, file.id]
      )
    )
    transfer = { upload_url: null, verified_byte_offset: 0, hash_state: null }
  }
  const objects = (
    await db.query(
      safeSql`SELECT id,version,metadata,user_metadata FROM storage.objects WHERE bucket_id=$1 AND name=$2`,
      [bucket, file.key]
    )
  ).rows
  if (!objects.length) {
    if (file.size === 0) {
      const uploaded = await api.storage.from(bucket).upload(file.key, Buffer.alloc(0), {
        contentType: file.contentType,
        upsert: false,
        metadata: storageMetadata({ ...file, bytes: Buffer.alloc(0) }),
      })
      if (uploaded.error)
        throw new Error(`Empty Storage upload failed (${uploaded.error.statusCode})`)
      await advance(service, job, 'files', job.cursor)
      return
    }
    let url = transfer.upload_url
    let offset = url ? await uploadOffset(url, target.serviceRoleKey) : null
    if (offset === null) {
      url = await createUpload(
        target.supabaseUrl,
        target.serviceRoleKey,
        bucket,
        file.key,
        file.size,
        {
          contentType: file.contentType,
          metadata: JSON.stringify(storageMetadata({ ...file, bytes: Buffer.alloc(0) })),
        }
      )
      await recordTransfer((store) =>
        store.query(
          safeSql`UPDATE instant_import_service.transfers SET upload_url=$3 WHERE job_id=$1 AND id=$2`,
          [job.id, file.id, url]
        )
      )
      offset = 0
    }
    if (offset > file.size) throw new Error('Target upload length mismatch')
    // A finished resumable upload with no object would otherwise re-enter this state forever.
    if (offset === file.size) throw new Error('Storage upload completed without an object')
    const end = Math.min(file.size, offset + uploadChunkBytes)
    await uploadChunk(
      url,
      target.serviceRoleKey,
      offset,
      await storageSource(blob as SourceFile).read(offset, end)
    )
    await advance(service, job, 'files', job.cursor)
    return
  }
  const object = objects[0]
  if (
    transfer.storage_id &&
    (transfer.storage_id !== object.id || transfer.storage_version !== object.version)
  )
    throw new Error('Storage object version changed during verification')
  if (
    Number(object.metadata.size) !== file.size ||
    object.metadata.mimetype !== file.contentType ||
    canonical(object.user_metadata) !==
      canonical(storageMetadata({ ...file, bytes: Buffer.alloc(0) }))
  )
    throw new Error('Storage object metadata conflict')
  const offset = Number(transfer.verified_byte_offset),
    end = Math.min(file.size, offset + uploadChunkBytes)
  const digest = await createSHA256()
  if (transfer.hash_state) digest.load(transfer.hash_state)
  const bytes = await storageSource(
    { object_key: `${file.key}`, size: String(file.size), etag: null } as SourceFile,
    { url: target.supabaseUrl, key: target.serviceRoleKey, bucket }
  ).read(offset, end)
  digest.update(bytes)
  const current = (
    await db.query(safeSql`SELECT id,version FROM storage.objects WHERE bucket_id=$1 AND name=$2`, [
      bucket,
      file.key,
    ])
  ).rows[0]
  if (!current || current.id !== object.id || current.version !== object.version)
    throw new Error('Storage object version changed during verification')
  const state = Buffer.from(digest.save()),
    done = end === file.size
  if (done && digest.digest('hex') !== file.hash) throw new Error('Target Storage SHA-256 mismatch')
  await service.query(
    safeSql`UPDATE instant_import_service.transfers SET verified_byte_offset=$3,hash_state=$4,storage_id=$5,storage_version=$6 WHERE job_id=$1 AND id=$2`,
    [job.id, file.id, end, state, object.id, object.version]
  )
  if (done) {
    await targetBatch(db, job, plan, async () => {
      await db.query(
        safeSql`INSERT INTO ${qualified(schema, 'file_registry')}(source_id,object_key,logical_path,size,sha256,content_type,verified,storage_id) VALUES($1,$2,$3,$4,$5,$6,true,$7)`,
        [
          file.id,
          file.key,
          Buffer.from(JSON.stringify(file.path)),
          file.size,
          file.hash,
          file.contentType,
          object.id,
        ]
      )
    })
    await advance(service, job, 'files', { ...job.cursor, after: file.id })
  } else await advance(service, job, 'files', job.cursor)
}
