import type { Client } from 'pg'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { decryptTarget, encryptTarget, jobDestination, jobTarget } from '../src/server/credentials'
import type { Job } from '../src/workflow/store'

const resolve = vi.hoisted(() => vi.fn())
vi.mock('../src/server/oauth', () => ({ resolveOAuthTarget: resolve }))
const ref = 'a'.repeat(20),
  job = { id: 'job-id', target_ref: 'ui:destination' } as Job
const query = vi.fn(),
  db = { query } as unknown as Client
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('IMPORT_CREDENTIAL_KEY', Buffer.alloc(32, 7).toString('base64'))
  query.mockResolvedValue({
    rows: [
      {
        target_encrypted: encryptTarget(job.id, { mode: 'oauth', projectRef: ref }),
        session_hash: 'original-browser',
      },
    ],
  })
})
afterEach(() => vi.unstubAllEnvs())
it('persists only the project reference, not expiring credentials or OAuth tokens', () => {
  const stored = { mode: 'oauth' as const, projectRef: ref }
  expect(decryptTarget(job.id, encryptTarget(job.id, stored))).toEqual(stored)
})
it('resolves every batch using the job owner from the private ledger', async () => {
  resolve.mockResolvedValue({ databaseUrl: 'private' })
  await jobTarget(db, job)
  expect(resolve).toHaveBeenCalledWith('original-browser', ref, false)
  await jobTarget(db, job, true)
  expect(resolve).toHaveBeenLastCalledWith('original-browser', ref, true)
})
it('reads completed-project links without OAuth or a new temporary login', async () => {
  resolve.mockRejectedValue(new Error('Disconnected'))
  expect(await jobDestination(db, job)).toEqual({ supabaseUrl: `https://${ref}.supabase.co` })
  expect(resolve).not.toHaveBeenCalled()
})
it('preserves existing imported jobs that stored direct credentials', async () => {
  const old = {
    databaseUrl: 'postgresql://old',
    supabaseUrl: `https://${ref}.supabase.co`,
    serviceRoleKey: 'key',
  }
  query.mockResolvedValue({
    rows: [{ target_encrypted: encryptTarget(job.id, old), session_hash: 'owner' }],
  })
  expect(await jobTarget(db, job)).toEqual(old)
  expect(resolve).not.toHaveBeenCalled()
})
it('fails closed when a browser job has no stored target', async () => {
  query.mockResolvedValue({ rows: [] })
  await expect(jobTarget(db, job)).rejects.toThrow('unavailable')
  expect(resolve).not.toHaveBeenCalled()
})
it('cannot decrypt a destination from another job', async () => {
  query.mockResolvedValue({
    rows: [
      {
        target_encrypted: encryptTarget('other-job', { mode: 'oauth', projectRef: ref }),
        session_hash: 'owner',
      },
    ],
  })
  await expect(jobTarget(db, job)).rejects.toThrow()
  expect(resolve).not.toHaveBeenCalled()
})
