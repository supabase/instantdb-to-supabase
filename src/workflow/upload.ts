import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { safeSql } from '@supabase/pg-meta'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'

import { validatePath } from '../import/input'
import { analyzeMetadata } from '../import/plan'
import { ensureEmptySource, sourceConfig } from './source'
import {
  connectStore,
  createJob,
  getJob,
  initializeStore,
  packPlan,
  type SourceFile,
} from './store'
import { resolveTarget } from './target'
import { createUpload, uploadChunk, uploadChunkBytes, uploadOffset } from './tus'

/** Trusted operator ingestion. Browser upload authorization is deliberately not exposed here. */
export async function uploadFolder(
  root: string,
  targetRef: string,
  resumeId?: string,
  onRegistered?: (id: string) => void
) {
  resolveTarget(targetRef)
  const stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Select an extracted backup directory')
  const base = await realpath(root),
    paths: string[] = []
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name),
        key = relative(base, path)
      validatePath(key)
      if (entry.isSymbolicLink()) throw new Error('Backup symlinks are not supported')
      if (entry.isDirectory()) {
        if (!['entities', 'files', '__MACOSX'].includes(key) && !key.startsWith('__MACOSX/'))
          throw new Error('Unexpected backup directory')
        await walk(path)
      } else {
        if (!entry.isFile()) throw new Error('Unsupported backup entry')
        paths.push(key)
        if (paths.length > 10_000) throw new Error('Backup manifest entry limit exceeded')
      }
    }
  }
  await walk(base)
  if (new Set(paths.map((p) => p.normalize('NFC').toLowerCase())).size !== paths.length)
    throw new Error('Backup path collision')
  const configHandle = await open(
    join(base, 'config.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW
  )
  let config: Buffer
  try {
    if ((await configHandle.stat()).size > 8 * 1024 * 1024)
      throw new Error('Configuration byte limit exceeded')
    config = await configHandle.readFile()
  } finally {
    await configHandle.close()
  }
  // Resolve configuration before connecting: a throw between the two would leak the connection.
  const model = analyzeMetadata(config),
    storage = sourceConfig(),
    api = createClient(storage.url, storage.key, { auth: { persistSession: false } })
  const db = await connectStore()
  try {
    await initializeStore(db)
    const id = resumeId ?? (await createJob(db, targetRef, config))
    onRegistered?.(id)
    const job = await getJob(db, id)
    if (job.target_ref !== targetRef || !job.config.equals(config) || job.phase !== 'uploading')
      throw new Error('Upload job does not match input or is already frozen')
    if (
      !(
        await db.query(
          safeSql`SELECT pg_try_advisory_lock(hashtextextended($1,1735289202)) AS acquired`,
          [id]
        )
      ).rows[0].acquired
    )
      throw new Error('Another worker owns this upload')
    const bucket = await api.storage.getBucket(storage.bucket)
    if (bucket.error) {
      const result = await api.storage.createBucket(storage.bucket, { public: false })
      if (result.error) throw new Error('Source bucket creation failed')
    } else if (bucket.data.public) throw new Error('Source bucket must be private')
    for (const path of paths.sort()) {
      const entity = /^entities\/([^/]+)\.jsonl$/.exec(path),
        blob = /^files\/([^/]+)$/.exec(path)
      const kind =
        path === 'config.json'
          ? 'config'
          : entity
            ? 'entity'
            : blob && z.string().uuid().safeParse(blob[1]).success
              ? 'blob'
              : path === '.DS_Store' || path.startsWith('__MACOSX/') || path.endsWith('/.DS_Store')
                ? 'ignored'
                : null
      if (!kind) throw new Error('Unexpected backup entry')
      const handle = await open(join(base, path), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const before = await handle.stat()
        if (!before.isFile() || !Number.isSafeInteger(before.size))
          throw new Error('Unsupported backup file')
        const digest = createHash('sha256')
        for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 }))
          digest.update(chunk)
        const sha256 = digest.digest('hex')
        if (path === 'config.json' && sha256 !== createHash('sha256').update(config).digest('hex'))
          throw new Error('Configuration changed after job registration')
        let file = (
          await db.query<SourceFile & { upload_url: string | null }>(
            safeSql`SELECT * FROM instant_import_service.files WHERE job_id=$1 AND path=$2`,
            [id, path]
          )
        ).rows[0]
        if (!file) {
          const fileId = randomUUID()
          await db.query(
            safeSql`INSERT INTO instant_import_service.files(job_id,id,path,path_key,object_key,size,sha256,kind,namespace) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              id,
              fileId,
              path,
              path.normalize('NFC').toLowerCase(),
              `${id}/${fileId}`,
              before.size,
              sha256,
              kind,
              entity?.[1] ?? null,
            ]
          )
          file = (
            await db.query(
              safeSql`SELECT * FROM instant_import_service.files WHERE job_id=$1 AND id=$2`,
              [id, fileId]
            )
          ).rows[0]
        }
        if (file.sha256 !== sha256 || Number(file.size) !== before.size)
          throw new Error('Local file changed since upload registration')
        const objectUrl = `${storage.url}/storage/v1/object/authenticated/${storage.bucket}/${file.object_key}`
        let head = await fetch(objectUrl, {
          method: 'HEAD',
          headers: { Authorization: `Bearer ${storage.key}` },
          signal: AbortSignal.timeout(60_000),
        })
        // Storage reports a missing object as 404, or 400 on older releases. Any other
        // failure is transient or an authorization problem: uploading over it would only
        // turn a retryable condition into a 409 from the non-upserting creation request.
        if (!head.ok && ![400, 404].includes(head.status))
          throw new Error(`Source object lookup failed (${head.status})`)
        if (!head.ok && before.size === 0) {
          await ensureEmptySource(file.object_key, storage)
          head = await fetch(objectUrl, {
            method: 'HEAD',
            headers: { Authorization: `Bearer ${storage.key}` },
            signal: AbortSignal.timeout(60_000),
          })
        } else if (!head.ok) {
          let url = file.upload_url
          let offset = url ? await uploadOffset(url, storage.key) : null
          if (offset === null) {
            url = await createUpload(
              storage.url,
              storage.key,
              storage.bucket,
              file.object_key,
              before.size
            )
            await db.query(
              safeSql`UPDATE instant_import_service.files SET upload_url=$3 WHERE job_id=$1 AND id=$2`,
              [id, file.id, url]
            )
            offset = 0
          }
          if (offset > before.size) throw new Error('Upload offset exceeds input size')
          while (offset < before.size) {
            const size = Math.min(uploadChunkBytes, before.size - offset),
              bytes = Buffer.alloc(size)
            if (size && (await handle.read(bytes, 0, size, offset)).bytesRead !== size)
              throw new Error('Local file was truncated')
            await uploadChunk(url!, storage.key, offset, bytes)
            offset += size
          }
          head = await fetch(objectUrl, {
            method: 'HEAD',
            headers: { Authorization: `Bearer ${storage.key}` },
            signal: AbortSignal.timeout(60_000),
          })
        }
        const after = await handle.stat()
        if (
          !head.ok ||
          Number(head.headers.get('content-length')) !== before.size ||
          before.ctimeMs !== after.ctimeMs ||
          before.mtimeMs !== after.mtimeMs
        )
          throw new Error('Upload verification failed or local file changed')
        const etag = head.headers.get('etag')
        if (!etag) throw new Error('Source object has no immutable version')
        await db.query(
          safeSql`UPDATE instant_import_service.files SET etag=$3 WHERE job_id=$1 AND id=$2`,
          [id, file.id, etag]
        )
      } finally {
        await handle.close()
      }
    }
    const total = Number(
      (
        await db.query(
          safeSql`SELECT count(*) AS n FROM instant_import_service.files WHERE job_id=$1`,
          [id]
        )
      ).rows[0].n
    )
    if (total !== paths.length) throw new Error('Upload manifest changed')
    const frozen = await db.query(
      safeSql`UPDATE instant_import_service.jobs SET model=$2,phase='analyzing',revision=revision+1 WHERE id=$1 AND phase='uploading'`,
      [id, packPlan(model)]
    )
    if (frozen.rowCount !== 1) throw new Error('Upload was cancelled before input could be frozen')
    return id
  } finally {
    await db.end()
  }
}
