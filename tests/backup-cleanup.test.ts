import type { Client } from 'pg'
import { beforeEach, expect, it, vi } from 'vitest'

import { buildHandoff, handoffPrompt } from '../src/import/handoff'
import { analyze } from '../src/import/plan'
import { cleanupBackup, completionModel } from '../src/workflow/cleanup'
import { packPlan, type Job } from '../src/workflow/store'
import { entries } from './fixtures'

const mocks = vi.hoisted(() => ({ remove: vi.fn() }))
vi.mock('../src/workflow/source', () => ({ removeSourceObjects: mocks.remove }))
const id = '00000000-0000-4000-8000-000000000001'
const job = (index = 1) =>
  ({
    id,
    phase: 'cleanup',
    revision: '40',
    cursor: { index, after: 'verified-fingerprint', offset: 0 },
    model: packPlan(analyze(entries())),
  }) as Job
const store = () => {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 })
  return { query, db: { query } as unknown as Client }
}
beforeEach(() => vi.clearAllMocks())
it.each(['rows', 'completed', 'cancelled'])('refuses source deletion during %s', async (phase) => {
  const { db, query } = store()
  await expect(cleanupBackup(db, { ...job(), phase } as Job)).rejects.toThrow()
  expect(query).not.toHaveBeenCalled()
  expect(mocks.remove).not.toHaveBeenCalled()
})
it('requires the committed destination cleanup checkpoint', async () => {
  await expect(cleanupBackup(store().db, job(0))).rejects.toThrow()
  await expect(
    cleanupBackup(store().db, { ...job(), cursor: { index: 1, after: '', offset: 0 } })
  ).rejects.toThrow()
})
it('removes at most one page of owned objects before deleting their manifest entries', async () => {
  const { db, query } = store()
  const files = [{ id: 'file', object_key: `${id}/file` }]
  query.mockResolvedValueOnce({ rows: files })
  await cleanupBackup(db, job())
  expect(query.mock.calls[0][0]).toContain('WHERE job_id=$1')
  expect(query.mock.calls[0][0]).toContain('LIMIT 100')
  expect(mocks.remove).toHaveBeenCalledWith(files.map((f) => f.object_key))
  expect(query.mock.calls[1][0]).toContain(
    'DELETE FROM instant_import_service.files WHERE job_id=$1'
  )
  expect(query.mock.calls[1][1]).toEqual([id, ['file']])
  expect(mocks.remove.mock.invocationCallOrder[0]).toBeLessThan(query.mock.invocationCallOrder[1])
  expect(JSON.parse(query.mock.calls.at(-1)![1][2]).index).toBe(1)
})
it('retains deletion receipts for retry when Storage fails', async () => {
  const { db, query } = store()
  query.mockResolvedValueOnce({ rows: [{ id: 'file', object_key: `${id}/file` }] })
  mocks.remove.mockRejectedValueOnce(new Error('storage unavailable'))
  await expect(cleanupBackup(db, job())).rejects.toThrow('storage unavailable')
  expect(query).toHaveBeenCalledOnce()
})
it('deletes staged data in job-scoped bounded pages', async () => {
  const { db, query } = store()
  await cleanupBackup(db, job(2))
  expect(query.mock.calls[0][0]).toContain('LIMIT 1000')
  expect(query.mock.calls[0][0]).toContain('WHERE job_id=$1')
  expect(query.mock.calls[0][1]).toEqual([id])
  expect(JSON.parse(query.mock.calls.at(-1)![1][2]).index).toBe(2)
})
it('clears the original config only when cleanup is complete and records deletion', async () => {
  const { db, query } = store()
  await cleanupBackup(db, job(7))
  expect(query.mock.calls.some(([sql]) => sql.includes('SET config=$2,model=$3'))).toBe(true)
  expect(query.mock.calls.some(([sql]) => sql.includes("name='verification.json'"))).toBe(true)
  expect(query.mock.calls.at(-1)![1][1]).toBe('completed')
})
it('retains handoff metadata without rows, file bytes, edges, or original configuration secrets', () => {
  const plan = analyze(entries())
  const config = JSON.parse(plan.config.toString())
  config.adminToken = 'secret-admin-token'
  config.webhooks = [{ url: 'https://example.com/secret-url', headers: { x: 'secret-header' } }]
  plan.config = Buffer.from(JSON.stringify(config))
  plan.files = [{ bytes: Buffer.from('secret-file') } as never]
  const clean = completionModel(plan)
  expect(clean.namespaces.every((ns) => ns.rows.length === 0)).toBe(true)
  expect(clean.links.every((link) => link.edges.length === 0)).toBe(true)
  expect(clean.files).toEqual([])
  expect(JSON.parse(clean.config.toString()).rules).toEqual(config.rules)
  expect(clean.config.toString()).not.toContain('secret-')
  const handoff = buildHandoff(clean, {
    jobId: id,
    projectRef: 'abcdefghijklmnopqrst',
    permissionsApplied: true,
  })
  expect(handoff.items.some((i) => i.id === 'webhooks')).toBe(true)
  expect(handoffPrompt(clean, handoff, 'application')).toContain('supabase migration fetch')
  expect(handoffPrompt(clean, handoff, 'webhooks')).toContain('local config.json')
})
