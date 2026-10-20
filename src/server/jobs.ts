import { createHash, randomUUID } from 'node:crypto'
import { safeSql } from '@supabase/pg-meta'
import { createClient } from '@supabase/supabase-js'
import { zipSync } from 'fflate'
import type { Client } from 'pg'
import { start } from 'workflow/api'
import { z } from 'zod'

import { importBackup } from '../../workflows/import-backup'
import { fileSchema } from '../client/contracts'
import { preflight } from '../import/database'
import { validatePath } from '../import/input'
import { byCodeUnit } from '../import/json'
import { analyzeMetadata } from '../import/plan'
import { PlatformRetryError } from '../platform-retry'
import { capture, captureJobProgress, eventId, requestTelemetryId } from '../telemetry/server'
import { recordUsage, recordUsageDetached } from '../telemetry/usage'
import { ensureEmptySource, sourceConfig, storageSource } from '../workflow/source'
import { connectStore, createJob, packPlan, type SourceFile } from '../workflow/store'
import { connectTargetWithRefresh } from '../workflow/target'
import { encryptTarget } from './credentials'
import { oauthTargetSchema, resolveOAuthTarget } from './oauth'
import { workflowProgress } from './progress'
import {
  connectedSession,
  digest,
  errorResponse,
  HttpError,
  jsonBody,
  ownedJob,
  sameOrigin,
} from './session'
import { ensureSourceBucket, ensureStore } from './store-ready'

const storageApi = () => {
  const source = sourceConfig()
  return createClient(source.url, source.key, {
    auth: { persistSession: false },
    global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30000) }) },
  })
}
async function connect<T>(work: (db: Client) => Promise<T>) {
  const db = await connectStore()
  try {
    return await work(db)
  } finally {
    await db.end()
  }
}
async function locked(db: Client, id: string) {
  if (
    !(
      await db.query(
        safeSql`SELECT pg_try_advisory_lock(hashtextextended($1,1735289202)) AS acquired`,
        [id]
      )
    ).rows[0].acquired
  )
    throw new HttpError(409, 'The import is processing a batch. Try again shortly.')
}
async function ownedLockedJob(db: Client, request: Request, id: string) {
  // Do not let another session acquire a job's lock or discover whether it is busy.
  await ownedJob(db, request, id)
  await locked(db, id)
  return ownedJob(db, request, id)
}
export async function createBrowserJob(request: Request) {
  try {
    sameOrigin(request)
    const body = await jsonBody(request)
    const value = z
      .object({
        target: oauthTargetSchema,
        fileCount: z.number().int().min(1).max(10000),
        selectionHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(body)
    const owner = connectedSession(request)
    // Validate encryption before minting credentials or connecting.
    encryptTarget('preflight', value.target)
    await connect(ensureStore)
    const { target, db: destination } = await connectTargetWithRefresh((force) =>
      resolveOAuthTarget(owner.hash, value.target.projectRef, force)
    )
    try {
      try {
        await preflight(destination, 'instant_import_preflight')
      } finally {
        await destination.end()
      }
      const api = createClient(target.supabaseUrl, target.serviceRoleKey, {
        auth: { persistSession: false },
        global: {
          fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15000) }),
        },
      })
      const users = await api.auth.admin.listUsers({ page: 1, perPage: 1 })
      if (users.error || users.data.users.length) throw new Error('Auth preflight failed')
      const buckets = await api.storage.listBuckets()
      if (buckets.error || buckets.data.length) throw new Error('Storage preflight failed')
    } catch (error) {
      if (error instanceof HttpError || error instanceof PlatformRetryError) throw error
      console.error('Destination preflight failed (details withheld)')
      await Promise.all([
        recordUsageDetached(
          { action: 'instant_import_preflight_failed', properties: {} },
          { targetRef: value.target.projectRef }
        ),
        capture(requestTelemetryId(request, body), 'instant_import_preflight_failed', {}),
      ])
      throw new HttpError(
        400,
        'Could not validate a blank destination. Choose a healthy project with no application tables, accounts, or Storage buckets, and authorize database access through Supabase.'
      )
    }
    const jobId = await connect(async (db) => {
      await ensureStore(db)
      await ensureSourceBucket(db)
      await db.query(safeSql`BEGIN`)
      let id: string
      try {
        id = await createJob(db, `ui:${digest(target.supabaseUrl)}`, Buffer.alloc(0))
        await db.query(
          safeSql`INSERT INTO instant_import_service.browser_jobs(job_id,session_hash,target_encrypted,file_count,selection_hash,telemetry_id) VALUES($1,$2,$3,$4,$5,$6)`,
          [
            id,
            owner.hash,
            encryptTarget(id, value.target),
            value.fileCount,
            value.selectionHash,
            requestTelemetryId(request, body),
          ]
        )
        await db.query(safeSql`COMMIT`)
      } catch (error) {
        await db.query(safeSql`ROLLBACK`)
        throw error
      }
      await recordUsage(
        db,
        { action: 'instant_import_job_created', properties: { fileCount: value.fileCount } },
        { jobId: id, targetRef: value.target.projectRef },
        eventId(`${id}:created`)
      )
      return id
    })
    return Response.json({ jobId }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return errorResponse(error)
  }
}
export async function registerBrowserFile(request: Request, id: string) {
  try {
    sameOrigin(request)
    const file = fileSchema.parse(await jsonBody(request))
    validatePath(file.path)
    const entity = /^entities\/([^/]+)\.jsonl$/.exec(file.path)
    const kind =
      file.path === 'config.json'
        ? 'config'
        : entity
          ? 'entity'
          : /^files\/[a-f0-9-]{36}$/i.test(file.path)
            ? 'blob'
            : null
    if (!kind || (kind === 'config' && file.size > 8 * 1024 * 1024))
      throw new HttpError(400, 'Unsupported backup file')
    return await connect(async (db) => {
      const job = await ownedLockedJob(db, request, id)
      if (job.phase !== 'uploading')
        throw new HttpError(409, 'This import is no longer accepting files')
      const key = file.path.normalize('NFC').toLowerCase()
      let registered = (
        await db.query(
          safeSql`SELECT * FROM instant_import_service.files WHERE job_id=$1 AND path_key=$2`,
          [id, key]
        )
      ).rows[0]
      if (registered) {
        if (
          registered.path !== file.path ||
          registered.sha256 !== file.sha256 ||
          Number(registered.size) !== file.size
        )
          throw new HttpError(
            409,
            'The backup changed. Reselect the original folder or start a new import.'
          )
      } else {
        const count = (
          await db.query(
            safeSql`SELECT count(*) AS n FROM instant_import_service.files WHERE job_id=$1`,
            [id]
          )
        ).rows[0].n
        if (Number(count) >= job.file_count)
          throw new HttpError(409, 'The folder contains more files than the original selection')
        const fileId = randomUUID()
        registered = (
          await db.query(
            safeSql`INSERT INTO instant_import_service.files(job_id,id,path,path_key,object_key,size,sha256,kind,namespace) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [
              id,
              fileId,
              file.path,
              key,
              `${id}/${fileId}`,
              file.size,
              file.sha256,
              kind,
              entity?.[1] ?? null,
            ]
          )
        ).rows[0]
      }
      if (!registered.etag && Number(registered.size) === 0) {
        const etag = await ensureEmptySource(registered.object_key)
        await db.query(
          safeSql`UPDATE instant_import_service.files SET etag=$3 WHERE job_id=$1 AND id=$2`,
          [id, registered.id, etag]
        )
        registered.etag = etag
      }
      const source = sourceConfig(),
        uploaded = !!registered.etag
      const signed = uploaded
        ? null
        : await storageApi()
            .storage.from(source.bucket)
            .createSignedUploadUrl(registered.object_key)
      if (signed?.error) throw new Error('Upload authorization failed')
      return Response.json(
        {
          id: registered.id,
          uploaded,
          endpoint: `${source.url}/storage/v1/upload/resumable/sign`,
          token: signed?.data?.token,
          bucket: source.bucket,
          objectKey: registered.object_key,
        },
        { headers: { 'Cache-Control': 'no-store' } }
      )
    })
  } catch (error) {
    return errorResponse(error)
  }
}
export async function completeBrowserFile(request: Request, id: string, fileId: string) {
  try {
    sameOrigin(request)
    if (!z.string().uuid().safeParse(fileId).success) throw new HttpError(404, 'File not found')
    return await connect(async (db) => {
      const job = await ownedLockedJob(db, request, id)
      if (job.phase !== 'uploading')
        throw new HttpError(409, 'This import is no longer accepting files')
      const file = (
        await db.query(
          safeSql`SELECT * FROM instant_import_service.files WHERE job_id=$1 AND id=$2`,
          [id, fileId]
        )
      ).rows[0]
      if (!file) throw new HttpError(404, 'File not found')
      const source = sourceConfig(),
        head = await fetch(
          `${source.url}/storage/v1/object/authenticated/${source.bucket}/${file.object_key}`,
          {
            method: 'HEAD',
            headers: { Authorization: `Bearer ${source.key}` },
            signal: AbortSignal.timeout(30000),
          }
        )
      const etag = head.headers.get('etag')
      if (!head.ok || !etag || Number(head.headers.get('content-length')) !== Number(file.size))
        throw new HttpError(409, 'The file upload is incomplete. Resume the upload and try again.')
      if (file.etag && file.etag !== etag)
        throw new HttpError(409, 'An uploaded file changed. Start a new import.')
      await db.query(
        safeSql`UPDATE instant_import_service.files SET etag=$3 WHERE job_id=$1 AND id=$2`,
        [id, fileId, etag]
      )
      return Response.json({ uploaded: true })
    })
  } catch (error) {
    return errorResponse(error)
  }
}
export async function startBrowserJob(request: Request, id: string) {
  try {
    sameOrigin(request)
    return await connect(async (db) => {
      const job = await ownedLockedJob(db, request, id)
      if (job.phase === 'cancelled' || job.phase === 'blocked')
        throw new HttpError(409, 'Start a new import to use another destination')
      if (job.run_id) {
        const progress = await workflowProgress(db, id, job.run_id)
        if (!['failed', 'cancelled'].includes(progress.status))
          return Response.json({ jobId: id, runId: progress.runId })
      }
      if (job.phase === 'uploading') {
        const files = (
          await db.query<SourceFile>(
            safeSql`SELECT * FROM instant_import_service.files WHERE job_id=$1`,
            [id]
          )
        ).rows.sort((a, b) => byCodeUnit(a.path, b.path))
        const selectionHash = digest(JSON.stringify(files.map((f) => [f.path, Number(f.size)])))
        if (
          files.length !== job.file_count ||
          files.some((f) => !f.etag) ||
          selectionHash !== job.selection_hash
        )
          throw new HttpError(409, 'Finish uploading the original backup folder before starting')
        const file = files.find((f) => f.path === 'config.json')
        if (!file) throw new HttpError(400, 'The backup is missing config.json')
        const config = await storageSource(file).read(0, Number(file.size))
        if (createHash('sha256').update(config).digest('hex') !== file.sha256)
          throw new HttpError(409, 'The uploaded configuration changed. Start a new import.')
        let model
        try {
          model = analyzeMetadata(config)
        } catch {
          throw new HttpError(
            400,
            'config.json is not a supported backup schema. Check the extracted backup and start a new import.'
          )
        }
        await db.query(
          safeSql`UPDATE instant_import_service.jobs SET config=$2,model=$3,phase='analyzing',revision=revision+1 WHERE id=$1 AND phase='uploading'`,
          [id, config, packPlan(model)]
        )
      }
      if (job.phase === 'uploading') await captureJobProgress(db, id, 'analyzing')
      const run = await start(importBackup, [id])
      await db.query(
        safeSql`UPDATE instant_import_service.browser_jobs SET run_id=$2 WHERE job_id=$1`,
        [id, run.runId]
      )
      return Response.json({ jobId: id, runId: run.runId }, { status: 202 })
    })
  } catch (error) {
    return errorResponse(error)
  }
}
export async function browserJobStatus(request: Request, id: string) {
  try {
    return await connect(async (db) => {
      const job = await ownedJob(db, request, id)
      const counts = (
        await db.query(
          safeSql`SELECT count(*) FILTER(WHERE etag IS NOT NULL) AS uploaded FROM instant_import_service.files WHERE job_id=$1`,
          [id]
        )
      ).rows[0]
      const progress = job.run_id
        ? await workflowProgress(db, id, job.run_id)
        : {
            status:
              job.phase === 'cancelled'
                ? 'cancelled'
                : job.phase === 'uploading'
                  ? 'uploading'
                  : 'pending',
            phase: null,
            revision: null,
            retrying: false,
            attempt: 1,
            startedAt: null,
          }
      const artifacts =
        progress.status === 'completed'
          ? (
              await db.query(
                safeSql`SELECT name FROM instant_import_service.artifacts WHERE job_id=$1 ORDER BY name`,
                [id]
              )
            ).rows.map((r) => r.name)
          : []
      return Response.json(
        {
          jobId: id,
          ...progress,
          cancelRequested: job.cancel_requested,
          uploadedFiles: ['cleanup', 'completed'].includes(job.phase)
            ? job.file_count
            : Number(counts.uploaded),
          totalFiles: job.file_count,
          artifacts,
        },
        { headers: { 'Cache-Control': 'no-store' } }
      )
    })
  } catch (error) {
    return errorResponse(error)
  }
}
export async function cancelBrowserJob(request: Request, id: string) {
  try {
    sameOrigin(request)
    return await connect(async (db) => {
      const job = await ownedLockedJob(db, request, id)
      await db.query(
        safeSql`UPDATE instant_import_service.jobs SET cancel_requested=true,phase=CASE WHEN phase='uploading' THEN 'cancelled' ELSE phase END WHERE id=$1`,
        [id]
      )
      if (!['uploading', 'completed', 'cancelled', 'blocked'].includes(job.phase)) {
        const run = await start(importBackup, [id])
        await db.query(
          safeSql`UPDATE instant_import_service.browser_jobs SET run_id=$2 WHERE job_id=$1`,
          [id, run.runId]
        )
      }
      if (job.phase === 'uploading') await captureJobProgress(db, id, 'cancelled')
      return Response.json({ cancelRequested: true }, { status: 202 })
    })
  } catch (error) {
    return errorResponse(error)
  }
}
export async function downloadArtifacts(request: Request, id: string) {
  try {
    return await connect(async (db) => {
      await ownedJob(db, request, id)
      const name = new URL(request.url).searchParams.get('name') ?? ''
      let bytes: Buffer, filename: string, type: string
      if (name === 'migrations.zip') {
        const rows = (
          await db.query(
            safeSql`SELECT name,bytes FROM instant_import_service.artifacts WHERE job_id=$1 AND name LIKE 'migrations/%' ORDER BY name`,
            [id]
          )
        ).rows
        if (!rows.length) throw new HttpError(404, 'Migrations are not ready yet')
        bytes = Buffer.from(
          zipSync(Object.fromEntries(rows.map((r) => [r.name, new Uint8Array(r.bytes)])))
        )
        filename = 'migrations.zip'
        type = 'application/zip'
      } else {
        if (
          ![
            'permissions.sql',
            'permissions.json',
            'permissions-manual.md',
            'verification.json',
          ].includes(name)
        )
          throw new HttpError(404, 'Report not found')
        const row = (
          await db.query(
            safeSql`SELECT bytes FROM instant_import_service.artifacts WHERE job_id=$1 AND name=$2`,
            [id, name]
          )
        ).rows[0]
        if (!row) throw new HttpError(404, 'Report is not ready yet')
        bytes = row.bytes
        filename = name
        type = 'application/octet-stream'
      }
      return new Response(new Uint8Array(bytes), {
        headers: {
          'Content-Type': type,
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store',
        },
      })
    })
  } catch (error) {
    return errorResponse(error)
  }
}
