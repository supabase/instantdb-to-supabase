import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ident, safeSql } from '@supabase/pg-meta'
import { createClient } from '@supabase/supabase-js'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { getRun } from 'workflow/api'

import { basePath } from '../src/base-path'
import { schemaFingerprint } from '../src/import/fingerprint'
import { readBackupFolder } from '../src/import/input'
import { analyze } from '../src/import/plan'
import { publicTables } from '../src/import/relational'
import { ensureStore } from '../src/server/store-ready'
import { cleanupBackup } from '../src/workflow/cleanup'
import { executeImportStep } from '../src/workflow/engine'
import { rowPage } from '../src/workflow/staging'
import { getJob, unpackPlan } from '../src/workflow/store'
import { targetSchema } from '../src/workflow/target'
import { uploadFolder } from '../src/workflow/upload'
import { entries, fixture, fullEntries, ids } from './fixtures'

const enabled = !!process.env.IMPORT_JOB_DATABASE_URL
const target = {
  databaseUrl: process.env.IMPORT_TEST_DATABASE_URL!,
  supabaseUrl: process.env.IMPORT_TEST_SUPABASE_URL!,
  serviceRoleKey: process.env.IMPORT_TEST_SERVICE_ROLE_KEY!,
}
if (
  enabled &&
  ![
    target.databaseUrl,
    target.supabaseUrl,
    process.env.IMPORT_JOB_DATABASE_URL!,
    process.env.IMPORT_JOB_SUPABASE_URL!,
  ].every((url) => ['127.0.0.1', 'localhost'].includes(new URL(url).hostname))
)
  throw new Error('Workflow integration tests require disposable local projects')

describe.skipIf(!enabled)('durable bounded import pipeline', { timeout: 180000 }, () => {
  const service = new Client({ connectionString: process.env.IMPORT_JOB_DATABASE_URL }),
    db = new Client({ connectionString: target.databaseUrl })
  const api = createClient(
    target.supabaseUrl || 'http://127.0.0.1',
    target.serviceRoleKey || 'unused',
    { auth: { persistSession: false } }
  )
  let jobId: string | undefined
  const folders: string[] = []
  beforeAll(async () => {
    process.env.IMPORT_TARGETS_JSON = JSON.stringify({ test: target })
    await service.connect()
    await db.connect()
    await ensureStore(service)
  })
  afterAll(async () => {
    await service.end()
    await db.end()
  })
  afterEach(async () => {
    if (jobId) {
      const job = await getJob(service, jobId)
      if (job.model) {
        const plan = unpackPlan(job.model),
          schema = targetSchema(plan)
        {
          for (const table of publicTables(plan).reverse())
            await db.query(safeSql`DROP TABLE IF EXISTS public.${ident(table)} CASCADE`)
          await db.query(safeSql`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`)
          await db.query(
            safeSql`DROP SCHEMA IF EXISTS ${ident(`instant_permissions_${plan.contentHash.slice(0, 24)}`)} CASCADE`
          )
          await db.query(
            'DELETE FROM supabase_migrations.schema_migrations WHERE name LIKE $1 OR name LIKE $2 OR name=$3',
            [
              `import_schema_${plan.contentHash.slice(0, 12)}`,
              `import_constraints_${plan.contentHash.slice(0, 12)}_%`,
              `import_permissions_${plan.contentHash.slice(0, 12)}`,
            ]
          )
        }
      }
      const users = (
        await db.query(
          "SELECT id FROM auth.users WHERE raw_app_meta_data->>'instant_import_owner'=$1",
          [jobId]
        )
      ).rows
      for (const u of users) await api.auth.admin.deleteUser(u.id)
      const bucket = `instant-${jobId}`,
        files = (await db.query('SELECT name FROM storage.objects WHERE bucket_id=$1', [bucket]))
          .rows
      if (files.length) await api.storage.from(bucket).remove(files.map((f) => f.name))
      await api.storage.deleteBucket(bucket)
      const sourceApi = createClient(
        process.env.IMPORT_JOB_SUPABASE_URL!,
        process.env.IMPORT_JOB_SERVICE_ROLE_KEY!,
        { auth: { persistSession: false } }
      )
      const sourceFiles = (
        await service.query('SELECT object_key FROM instant_import_service.files WHERE job_id=$1', [
          jobId,
        ])
      ).rows
      if (sourceFiles.length)
        await sourceApi.storage
          .from('instant-import-inputs')
          .remove(sourceFiles.map((f) => f.object_key))
      for (const table of [
        'artifacts',
        'transfers',
        'blobs',
        'unique_values',
        'edges',
        'rows',
        'files',
        'targets',
      ])
        await service.query(
          safeSql`DELETE FROM instant_import_service.${ident(table)} WHERE job_id=$1`,
          [jobId]
        )
      await service.query('DELETE FROM instant_import_service.jobs WHERE id=$1', [jobId])
      jobId = undefined
    }
    for (const path of folders.splice(0)) await rm(path, { recursive: true, force: true })
  })
  async function upload(
    input: Map<string, Buffer> = entries(),
    onRegistered?: (folder: string) => void
  ) {
    const folder = await mkdtemp(join(tmpdir(), 'workflow-test-'))
    folders.push(folder)
    await mkdir(join(folder, 'entities'))
    await mkdir(join(folder, 'files'))
    for (const [path, bytes] of input) await writeFile(join(folder, path), bytes)
    jobId = await uploadFolder(folder, 'test', undefined, (id) => {
      jobId = id
      onRegistered?.(folder)
    })
    return jobId
  }
  async function step() {
    return executeImportStep(jobId!, undefined, (e) => {
      process.stderr.write(`${(e as Error).message}\n`)
    })
  }
  async function finish() {
    for (let n = 0; n < 2000; n++) {
      const result = await step()
      if (result.terminal) return result
    }
    throw new Error('Pipeline failed to make bounded progress')
  }
  async function waitForRun(runId: string, expected = 'completed'): Promise<void> {
    const run = getRun<{ jobId: string; state: string; nextRunId?: string }>(runId)
    for (let n = 0; n < 600; n++) {
      const status = await run.status
      if (status === expected) {
        if (status === 'completed') {
          const value = await run.returnValue
          expect(value.jobId).toBe(jobId)
          if (value.nextRunId) await waitForRun(value.nextRunId)
          else expect(value.state).toBe('completed')
        }
        return
      }
      if (expected !== 'failed') expect(status).not.toBe('failed')
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error('Workflow run did not finish')
  }
  async function httpRun(expected: string) {
    const url = `${process.env.IMPORT_WORKFLOW_TEST_URL}${basePath}/api/import-jobs/${jobId}`
    const headers = { Authorization: 'Bearer local-workflow-test-token' }
    const response = await fetch(url, { method: 'POST', headers })
    expect(response.status).toBe(202)
    const { runId } = await response.json()
    for (let n = 0; n < 600; n++) {
      const response = await fetch(url, { headers })
      expect(response.status).toBe(200)
      const status = await response.json()
      if (status.state === expected) {
        await waitForRun(runId, expected)
        return status
      }
      if (expected !== 'failed') expect(status.state).not.toBe('failed')
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error('Workflow did not reach the expected state')
  }
  it('imports through durable stages and generates the same relational model', async () => {
    const input = entries(),
      expected = analyze(input)
    await upload(input)
    expect((await finish()).state).toBe('completed')
    const job = await getJob(service, jobId!),
      plan = unpackPlan(job.model!)
    expect(plan.totals).toEqual(expected.totals)
    expect(job.config.length).toBe(0)
    for (const table of ['files', 'rows', 'edges', 'unique_values', 'blobs', 'transfers'])
      expect(
        (
          await service.query(
            safeSql`SELECT count(*) AS n FROM instant_import_service.${ident(table)} WHERE job_id=$1`,
            [jobId]
          )
        ).rows[0].n
      ).toBe('0')
    const sourceApi = createClient(
      process.env.IMPORT_JOB_SUPABASE_URL!,
      process.env.IMPORT_JOB_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    )
    expect((await sourceApi.storage.from('instant-import-inputs').list(jobId!)).data).toEqual([])
    expect(plan.links).toEqual(expected.links.map((l) => ({ ...l, edges: [] })))
    expect((await db.query('SELECT name FROM public.people ORDER BY name')).rows).toEqual([
      { name: 'One' },
      { name: 'Two' },
    ])
    expect(
      (
        await service.query('SELECT name FROM instant_import_service.artifacts WHERE job_id=$1', [
          jobId,
        ])
      ).rows.map((r) => r.name)
    ).toContain('permissions-manual.md')
    expect((await step()).state).toBe('completed')
    expect(
      (await db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [targetSchema(plan)])).rows
    ).toEqual([])
    const migrationText = (
      await db.query('SELECT statements FROM supabase_migrations.schema_migrations')
    ).rows
      .flatMap((r) => r.statements)
      .join('\n')
    expect(migrationText).not.toMatch(
      /CREATE SCHEMA instant_|CREATE FUNCTION|workflow_batches|provenance/
    )
  })
  it('applies supported security and records a replayable migration while unsupported rules remain closed', async () => {
    const input = entries(),
      config = JSON.parse(input.get('config.json')!.toString())
    config.rules = {
      $default: { allow: { $default: 'false' } },
      people: { allow: { view: 'auth.id == data.id', update: 'newData.name == data.name' } },
    }
    input.set('config.json', Buffer.from(JSON.stringify(config)))
    await upload(input)
    await finish()
    const policies = (
      await db.query(
        "SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='people'"
      )
    ).rows
    expect(policies).toEqual([{ policyname: 'import_view' }])
    const history = (
      await db.query(
        "SELECT statements FROM supabase_migrations.schema_migrations WHERE name LIKE 'import_permissions_%'"
      )
    ).rows
    expect(history).toHaveLength(1)
    expect(history[0].statements.join('\n')).toContain('CREATE POLICY')
    const report = (
      await service.query(
        "SELECT bytes FROM instant_import_service.artifacts WHERE job_id=$1 AND name='verification.json'",
        [jobId]
      )
    ).rows[0]
    expect(JSON.parse(report.bytes.toString()).permissionsApplied).toBe(true)
    await db.query('BEGIN')
    try {
      await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [ids[0]])
      await db.query('SET LOCAL ROLE authenticated')
      expect((await db.query('SELECT name FROM public.people')).rows).toEqual([{ name: 'One' }])
      await expect(db.query("UPDATE public.people SET name='Forbidden'")).rejects.toThrow(
        /permission denied/
      )
    } finally {
      await db.query('ROLLBACK')
    }
  })
  it('reconciles a committed row batch after its acknowledgement is lost', async () => {
    await upload()
    while ((await getJob(service, jobId!)).phase !== 'rows') await step()
    while ((await getJob(service, jobId!)).cursor.index === 0) await step()
    const before = await getJob(service, jobId!)
    await expect(
      executeImportStep(jobId!, async () => {
        throw new Error('simulated lost ack')
      })
    ).rejects.toThrow()
    expect((await getJob(service, jobId!)).revision).toBe(before.revision)
    expect((await db.query('SELECT count(*) AS n FROM public.people')).rows[0].n).toBe('2')
    await finish()
    expect((await db.query('SELECT count(*) AS n FROM public.people')).rows[0].n).toBe('2')
  })
  it.each(['schema', 'auth', 'files', 'links', 'constraints', 'reports', 'cleanup'])(
    'resumes after losing the service checkpoint in %s',
    async (phase) => {
      await upload(fullEntries())
      while ((await getJob(service, jobId!)).phase !== phase) await step()
      const before = await getJob(service, jobId!)
      await expect(
        executeImportStep(jobId!, async () => {
          throw new Error('lost checkpoint')
        })
      ).rejects.toThrow()
      expect((await getJob(service, jobId!)).revision).toBe(before.revision)
      expect((await finish()).state).toBe('completed')
      expect((await db.query('SELECT count(*) AS n FROM public.people')).rows[0].n).toBe('2')
      expect((await db.query('SELECT count(*) AS n FROM auth.users')).rows[0].n).toBe('1')
      expect((await db.query('SELECT count(*) AS n FROM storage.objects')).rows[0].n).toBe('3')
      if (phase === 'reports') {
        expect(
          (
            await db.query(
              "SELECT count(*) AS n FROM supabase_migrations.schema_migrations WHERE name LIKE 'import_permissions_%'"
            )
          ).rows[0].n
        ).toBe('1')
        expect(
          (await db.query("SELECT count(*) AS n FROM pg_policies WHERE schemaname='public'"))
            .rows[0].n
        ).not.toBe('0')
      }
    }
  )
  it('handles Auth, logical guests, shared blobs, and empty file bytes', async () => {
    await upload(fullEntries())
    expect((await finish()).state).toBe('completed')
    expect((await db.query('SELECT count(*) AS n FROM auth.users')).rows[0].n).toBe('1')
    expect((await db.query('SELECT count(*) AS n FROM storage.objects')).rows[0].n).toBe('3')
  })
  it('rejects a duplicate ID across source batches before creating target tables', async () => {
    const input = entries(),
      f = fixture(),
      config = f.config
    const rows = Array.from({ length: 501 }, (_, i) => ({
      entity: {
        id: i === 500 ? ids[0] : `00000000-0000-4000-8000-${(i + 1).toString().padStart(12, '0')}`,
        name: `Row ${i}`,
      },
      createdAt: 0,
    }))
    config.counts.people = 501
    input.set('config.json', Buffer.from(JSON.stringify(config)))
    input.set('entities/people.jsonl', Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n')))
    await upload(input)
    await expect(finish()).rejects.toThrow()
    expect(
      (await db.query("SELECT to_regclass('public.people') AS table")).rows[0].table
    ).toBeNull()
  })
  it('stops at a cancellation boundary without deleting imported resources', async () => {
    await upload()
    while ((await getJob(service, jobId!)).phase !== 'rows') await step()
    await service.query(
      'UPDATE instant_import_service.jobs SET cancel_requested=true WHERE id=$1',
      [jobId]
    )
    expect((await step()).state).toBe('cancelled')
    expect((await db.query("SELECT to_regclass('public.people') AS table")).rows[0].table).toBe(
      'people'
    )
  })
  it('serializes competing workers without duplicate progress', async () => {
    await upload()
    await service.query('SELECT pg_advisory_lock(hashtextextended($1,1735289202))', [jobId])
    try {
      expect((await step()).state).toBe('busy')
    } finally {
      await service.query('SELECT pg_advisory_unlock(hashtextextended($1,1735289202))', [jobId])
    }
    await finish()
  })
  it('keeps private staging tables inaccessible to application roles', async () => {
    const result = await service.query(
      "SELECT relrowsecurity,has_schema_privilege('anon','instant_import_service','usage') AS anon,has_table_privilege('authenticated',c.oid,'select') AS authenticated FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='instant_import_service' AND c.relkind='r'"
    )
    expect(result.rows.length).toBeGreaterThan(0)
    for (const row of result.rows)
      expect(row).toEqual({ relrowsecurity: true, anon: false, authenticated: false })
  })
  it.each(['counts', 'missing endpoint', 'required relationship', 'unique values'])(
    'rejects invalid %s before target mutation',
    async (kind) => {
      const input = entries(),
        f = fixture()
      if (kind === 'counts') f.config.counts.people = 3
      if (kind === 'missing endpoint') f.rows[0].entity.friends = [ids[2]]
      if (kind === 'required relationship')
        Object.assign(f.config.schema.links.friends.reverse, { required: true })
      if (kind === 'unique values') {
        f.config.schema.entities.people.attrs.name.config.unique = true
        f.rows[1].entity.name = f.rows[0].entity.name
      }
      input.set('config.json', Buffer.from(JSON.stringify(f.config)))
      input.set(
        'entities/people.jsonl',
        Buffer.from(f.rows.map((r) => JSON.stringify(r)).join('\n'))
      )
      await upload(input)
      await expect(finish()).rejects.toThrow()
      expect(
        (await db.query("SELECT to_regclass('public.people') AS name")).rows[0].name
      ).toBeNull()
    }
  )
  it('bounds wide row pages by bytes and resolves relationships across 500-row boundaries', async () => {
    const input = entries(),
      f = fixture()
    const rows = Array.from({ length: 601 }, (_, i) => ({
      entity: {
        id: `00000000-0000-4000-8000-${(i + 1).toString().padStart(12, '0')}`,
        name: `Row ${i}`,
        optional: 'x'.repeat(6000),
        friends: [`00000000-0000-4000-8000-${(((i + 1) % 601) + 1).toString().padStart(12, '0')}`],
      },
      createdAt: i,
    }))
    f.config.counts.people = rows.length
    input.set('config.json', Buffer.from(JSON.stringify(f.config)))
    input.set('entities/people.jsonl', Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n')))
    await upload(input)
    while ((await getJob(service, jobId!)).phase !== 'schema') await step()
    const page = await rowPage(service, jobId!, 'people', '')
    expect(page.length).toBeLessThan(500)
    expect(page.reduce((n, r) => n + r.raw.length + r.normalized.length, 0)).toBeLessThanOrEqual(
      2 * 1024 * 1024
    )
    await finish()
    expect((await db.query('SELECT count(*) AS n FROM public.people')).rows[0].n).toBe('601')
    expect((await db.query('SELECT count(*) AS n FROM public.people_friends')).rows[0].n).toBe(
      '601'
    )
  })
  it('refuses destination schema changes between batches', async () => {
    await upload()
    while ((await getJob(service, jobId!)).phase !== 'rows') await step()
    await db.query('ALTER TABLE public.people ADD COLUMN unexpected text')
    await expect(step()).rejects.toThrow()
  })
  it('refuses cleanup after unexpected destination changes', async () => {
    await upload()
    while ((await getJob(service, jobId!)).phase !== 'cleanup') await step()
    const plan = unpackPlan((await getJob(service, jobId!)).model!)
    await db.query('ALTER TABLE public.people ADD COLUMN unexpected text')
    await expect(step()).rejects.toThrow()
    expect(
      (await db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [targetSchema(plan)])).rowCount
    ).toBe(1)
  })
  it('keeps backups private and retries deletion without touching another job', async () => {
    await upload()
    const sourceApi = createClient(
      process.env.IMPORT_JOB_SUPABASE_URL!,
      process.env.IMPORT_JOB_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    )
    const bucket = sourceApi.storage.from('instant-import-inputs')
    const otherKey = `${randomUUID()}/${randomUUID()}`
    const sourceKey = (
      await service.query(
        'SELECT object_key FROM instant_import_service.files WHERE job_id=$1 LIMIT 1',
        [jobId]
      )
    ).rows[0].object_key
    const email = `isolation-${randomUUID()}@example.com`
    const password = randomUUID()
    const user = await sourceApi.auth.admin.createUser({ email, password, email_confirm: true })
    expect(user.error).toBeNull()
    try {
      expect((await bucket.upload(otherKey, Buffer.from('another job'))).error).toBeNull()
      expect((await sourceApi.storage.getBucket('instant-import-inputs')).data?.public).toBe(false)
      const login = await sourceApi.auth.signInWithPassword({ email, password })
      expect(login.error).toBeNull()
      // A valid unrelated Auth session must not gain access even with an exact object key.
      const response = await fetch(
        `${process.env.IMPORT_JOB_SUPABASE_URL}/storage/v1/object/authenticated/instant-import-inputs/${sourceKey}`,
        {
          headers: {
            apikey: process.env.IMPORT_JOB_SERVICE_ROLE_KEY!,
            Authorization: `Bearer ${login.data.session!.access_token}`,
          },
        }
      )
      expect(response.ok).toBe(false)
      expect(await response.text()).not.toContain('"schema"')
      await sourceApi.auth.signOut()
      while ((await getJob(service, jobId!)).phase !== 'cleanup') await step()
      await step()
      const checkpoint = await getJob(service, jobId!)
      expect(checkpoint.cursor.index).toBe(1)
      await service.query('BEGIN')
      try {
        await cleanupBackup(service, checkpoint)
      } finally {
        await service.query('ROLLBACK')
      }
      // Remote objects are gone, while the rolled-back manifest still drives a safe retry.
      expect((await bucket.download(sourceKey)).error).not.toBeNull()
      expect(
        (await service.query('SELECT 1 FROM instant_import_service.files WHERE job_id=$1', [jobId]))
          .rowCount
      ).toBeGreaterThan(0)
      await finish()
      const other = await bucket.download(otherKey)
      expect(other.error).toBeNull()
      expect(await other.data!.text()).toBe('another job')
      expect((await bucket.list(jobId!)).data).toEqual([])
    } finally {
      await sourceApi.auth.signOut()
      await bucket.remove([otherKey])
      if (user.data.user) await sourceApi.auth.admin.deleteUser(user.data.user.id)
    }
  })
  it('refuses changed policies after a lost completion checkpoint', async () => {
    await upload()
    while ((await getJob(service, jobId!)).phase !== 'reports') await step()
    await expect(
      executeImportStep(jobId!, async () => {
        throw new Error('lost checkpoint')
      })
    ).rejects.toThrow()
    await db.query('GRANT UPDATE ON public.people TO anon')
    await expect(step()).rejects.toThrow()
  })
  it('copies and incrementally verifies files across multiple 6 MiB chunks', async () => {
    const input = fullEntries(),
      size = 13 * 1024 * 1024
    const records = input
      .get('entities/$files.jsonl')!
      .toString()
      .split('\n')
      .map((s) => JSON.parse(s))
    for (const row of records) if (row.entity['location-id'] === ids[0]) row.entity.size = size
    input.set(
      'entities/$files.jsonl',
      Buffer.from(records.map((r) => JSON.stringify(r)).join('\n'))
    )
    input.set(`files/${ids[0]}`, Buffer.alloc(size, 37))
    await upload(input)
    while ((await getJob(service, jobId!)).phase !== 'cleanup') await step()
    const transfers = (
      await service.query(
        'SELECT verified_byte_offset FROM instant_import_service.transfers WHERE job_id=$1 ORDER BY id',
        [jobId]
      )
    ).rows
    expect(transfers.map((r) => Number(r.verified_byte_offset))).toEqual([size, 0, size])
    await finish()
    expect(
      (
        await service.query('SELECT 1 FROM instant_import_service.transfers WHERE job_id=$1', [
          jobId,
        ])
      ).rows
    ).toEqual([])
  })
  it('checks source hashes before any target mutation', async () => {
    await upload()
    await service.query(
      "UPDATE instant_import_service.files SET sha256=repeat('0',64) WHERE job_id=$1 AND kind='entity'",
      [jobId]
    )
    await expect(finish()).rejects.toThrow()
    expect((await db.query("SELECT to_regclass('public.people') AS name")).rows[0].name).toBeNull()
  })
  it('rejects an isolated blank JSONL record', async () => {
    const input = entries(),
      config = fixture().config
    delete (config as { counts?: unknown }).counts
    input.set('config.json', Buffer.from(JSON.stringify(config)))
    input.set('entities/people.jsonl', Buffer.from('\n'))
    await upload(input)
    await expect(finish()).rejects.toThrow()
  })
  it('rejects configuration changes between registration and upload', async () => {
    await expect(
      upload(entries(), (folder) => {
        writeFileSync(join(folder, 'config.json'), JSON.stringify(fixture().config, null, 2))
      })
    ).rejects.toThrow('Configuration changed after job registration')
  })
  it.skipIf(!process.env.IMPORT_WORKFLOW_TEST_URL)(
    'reports exhausted retries and resumes the same checkpoint',
    async () => {
      await upload()
      while ((await getJob(service, jobId!)).phase !== 'schema') await step()
      await db.query('SELECT pg_advisory_lock(1735289201,1)')
      try {
        expect((await httpRun('failed')).phase).toBe('schema')
        expect(
          (await db.query("SELECT to_regclass('public.people') AS name")).rows[0].name
        ).toBeNull()
      } finally {
        await db.query('SELECT pg_advisory_unlock(1735289201,1)')
      }
      // A new run acknowledges the prior failure as it resumes; completion clears it.
      const url = `${process.env.IMPORT_WORKFLOW_TEST_URL}${basePath}/api/import-jobs/${jobId}`
      const restarted = await fetch(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer local-workflow-test-token' },
      })
      expect(restarted.status).toBe(202)
      const { runId } = await restarted.json()
      for (let n = 0; n < 600; n++) {
        if ((await getJob(service, jobId!)).phase === 'completed') {
          await waitForRun(runId)
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      throw new Error('Resume did not finish')
    }
  )
  it.skipIf(!process.env.IMPORT_WORKFLOW_TEST_URL)(
    'runs through the actual Workflow HTTP runtime with duplicate starts',
    async () => {
      await upload()
      const url = `${process.env.IMPORT_WORKFLOW_TEST_URL}${basePath}/api/import-jobs/${jobId}`
      const headers = { Authorization: 'Bearer local-workflow-test-token' }
      expect((await fetch(url)).status).toBe(401)
      const starts = await Promise.all([
        fetch(url, { method: 'POST', headers }),
        fetch(url, { method: 'POST', headers }),
      ])
      const runIds: string[] = []
      for (const response of starts) {
        expect(response.status).toBe(202)
        runIds.push((await response.json()).runId)
      }
      for (let i = 0; i < 400; i++) {
        const status = await (await fetch(url, { headers })).json()
        expect(status.state).not.toBe('failed')
        if (status.state === 'completed') {
          expect((await db.query('SELECT count(*) AS n FROM public.people')).rows[0].n).toBe('2')
          await Promise.all(runIds.map((id) => waitForRun(id)))
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      throw new Error('Workflow HTTP runtime did not finish')
    }
  )
  it.skipIf(!process.env.IMPORT_EXAMPLE_PATH)(
    'restores the supplied raw backup through the large-input pipeline',
    async () => {
      const input = await readBackupFolder(process.env.IMPORT_EXAMPLE_PATH!),
        expected = analyze(input)
      await upload(input)
      if (process.env.IMPORT_WORKFLOW_TEST_URL) {
        await httpRun('completed')
        expect(Number((await getJob(service, jobId!)).revision)).toBeGreaterThan(200)
      } else await finish()
      expect(unpackPlan((await getJob(service, jobId!)).model!).totals).toEqual(expected.totals)
      expect((await db.query('SELECT count(*) AS n FROM public.tasks')).rows[0].n).toBe('300')
      expect(
        Number((await db.query('SELECT count(*) AS n FROM public.document_versions')).rows[0].n)
      ).toBe(expected.namespaces.find((n) => n.source === 'documentVersions')!.rows.length)
      expect(
        (await db.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'instant_%'")).rows
      ).toEqual([])
      const before = await schemaFingerprint(db, 'public')
      const migrations = (
        await db.query(
          'SELECT statements FROM supabase_migrations.schema_migrations ORDER BY version'
        )
      ).rows
      await db.query('BEGIN')
      try {
        for (const table of publicTables(expected).reverse())
          await db.query(safeSql`DROP TABLE public.${ident(table)} CASCADE`)
        for (const migration of migrations)
          for (const statement of migration.statements) await db.query(statement)
        expect(await schemaFingerprint(db, 'public')).toBe(before)
        expect(
          (await db.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'instant_%'")).rows
        ).toEqual([])
      } finally {
        await db.query('ROLLBACK')
      }
    }
  )
})
