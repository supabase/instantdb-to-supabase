import type { Client } from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { recordBrowserUsage } from '../src/server/usage-action'
import { captureJobProgress, eventId } from '../src/telemetry/server'
import { recordUsage } from '../src/telemetry/usage'

const store = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn() }))
vi.mock('../src/workflow/store', () => ({
  connectStore: async () => ({ query: store.query, end: store.end }),
}))
const jobId = '00000000-0000-4000-8000-000000000001'
const ref = 'abcdefghijklmnopqrst'
const fetcher = vi.fn()
const inserts = (query = store.query) =>
  query.mock.calls
    .filter(([sql]) => String(sql).startsWith('INSERT INTO public.usage_events'))
    .map(([, values]) => ({
      id: values[0],
      event: values[1],
      jobId: values[2],
      targetRef: values[3],
      environment: values[4],
      properties: JSON.parse(values[5]),
    }))
beforeEach(() => {
  vi.clearAllMocks()
  store.query.mockResolvedValue({ rows: [] })
  store.end.mockResolvedValue(undefined)
  // PostHog is unconfigured: the usage log must not depend on it.
  vi.stubEnv('IMPORT_POSTHOG_KEY', '')
  vi.stubEnv('VERCEL_ENV', 'production')
  vi.stubGlobal('fetch', fetcher.mockResolvedValue(new Response(null, { status: 200 })))
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
describe('first-party usage log', () => {
  it('appends validated, idempotent rows with the destination ref', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Client
    await expect(
      recordUsage(
        db,
        { action: 'instant_import_job_created', properties: { fileCount: 3 } },
        { jobId, targetRef: ref },
        eventId('created')
      )
    ).resolves.toBe(true)
    const [sql] = vi.mocked(db.query).mock.calls[0]
    expect(String(sql)).toContain('ON CONFLICT(id) DO NOTHING')
    expect(inserts(vi.mocked(db.query))).toEqual([
      {
        id: eventId('created'),
        event: 'instant_import_job_created',
        jobId,
        targetRef: ref,
        environment: 'production',
        properties: { fileCount: 3 },
      },
    ])
  })
  it.each([
    { action: 'instant_import_job_created', properties: { fileCount: 3, email: 'a@b.co' } },
    { action: 'instant_import_control_clicked', properties: { importAction: 'retry', sql: 'x' } },
    { action: 'something_else', properties: {} },
  ])('rejects unexpected payloads ($action)', async (value) => {
    const db = { query: vi.fn() } as unknown as Client
    expect(await recordUsage(db, value as never)).toBe(false)
    expect(db.query).not.toHaveBeenCalled()
  })
  it('rejects anything but a project ref as the target', async () => {
    const db = { query: vi.fn() } as unknown as Client
    const value = { action: '$pageview', properties: {} } as const
    expect(await recordUsage(db, value, { targetRef: 'postgres://user:secret@host' })).toBe(false)
    expect(db.query).not.toHaveBeenCalled()
  })
  it('never throws and honors the kill switch', async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error('private')) } as unknown as Client
    const value = { action: '$pageview', properties: {} } as const
    await expect(recordUsage(db, value)).resolves.toBe(false)
    vi.stubEnv('IMPORT_USAGE_LOG', '0')
    vi.mocked(db.query).mockClear()
    expect(await recordUsage(db, value)).toBe(false)
    expect(db.query).not.toHaveBeenCalled()
  })
})
describe('worker progress backup', () => {
  it('records stages, upload stats, and completion totals without PostHog', async () => {
    const totals = { namespaces: 2, rows: 10, edges: 4, files: 1, bytes: 512 }
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT b.telemetry_id'))
        return { rows: [{ telemetry_id: null, error_code: null, elapsed_ms: 1200.4 }] }
      if (sql.startsWith('SELECT count(*) AS files'))
        return { rows: [{ files: '3', bytes: '2048', entities: '2', blobs: '1' }] }
      if (sql.startsWith("SELECT v->'verified'"))
        return {
          rows: [
            {
              verified: totals,
              source: totals,
              permissions: { converted: 3, manual: 1, excluded: 0 },
            },
          ],
        }
      return { rows: [] }
    })
    const db = { query } as unknown as Client
    await captureJobProgress(db, jobId, 'analyzing')
    await captureJobProgress(db, jobId, 'completed')
    expect(fetcher).not.toHaveBeenCalled()
    expect(inserts(query as never)).toEqual([
      expect.objectContaining({
        id: eventId(`${jobId}:upload`),
        event: 'instant_import_upload_completed',
        jobId,
        targetRef: null,
        properties: { fileCount: 3, totalBytes: 2048, entityFiles: 2, blobFiles: 1 },
      }),
      expect.objectContaining({
        id: eventId(`${jobId}:instant_import_stage_updated:analyzing`),
        properties: { importStage: 'analyzing', elapsedMs: 1200 },
      }),
      expect.objectContaining({
        id: eventId(`${jobId}:instant_import_completed:completed`),
        event: 'instant_import_completed',
        properties: {
          importStage: 'completed',
          elapsedMs: 1200,
          stats: {
            verified: totals,
            source: totals,
            permissions: { converted: 3, manual: 1, excluded: 0 },
          },
        },
      }),
    ])
  })
  it('records only fixed failure codes', async () => {
    const query = vi.fn(async (sql: string) =>
      sql.startsWith('SELECT b.telemetry_id')
        ? { rows: [{ error_code: 'RUN_FAILED', elapsed_ms: 5 }] }
        : { rows: [] }
    )
    await captureJobProgress({ query } as unknown as Client, jobId, 'rows', true)
    expect(inserts(query as never)[0]).toMatchObject({
      event: 'instant_import_failed',
      properties: { importStage: 'rows', elapsedMs: 5, errorCode: 'RUN_FAILED' },
    })
  })
})
describe('browser Server Action backup', () => {
  it('records validated events with no identifier', async () => {
    await recordBrowserUsage({
      action: 'instant_import_submitted',
      properties: { fileCount: 2, totalBytes: 10, importMode: 'new' },
    })
    expect(inserts()).toEqual([
      expect.objectContaining({
        event: 'instant_import_submitted',
        jobId: null,
        targetRef: null,
        properties: { fileCount: 2, totalBytes: 10, importMode: 'new' },
      }),
    ])
    expect(store.end).toHaveBeenCalled()
  })
  it.each([
    { action: 'instant_import_completed', properties: { jobId, importStage: 'completed' } },
    { action: 'instant_import_control_clicked', properties: { importAction: 'retry', ref } },
    { action: '$pageview', properties: {}, padding: 'x'.repeat(3000) },
    'not an event',
  ])('ignores forged, unexpected, or oversized input %#', async (value) => {
    await expect(recordBrowserUsage(value)).resolves.toBeUndefined()
    expect(store.query).not.toHaveBeenCalled()
  })
})
