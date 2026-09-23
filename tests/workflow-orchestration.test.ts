import { beforeEach, describe, expect, it, vi } from 'vitest'

import { importBackup } from '../workflows/import-backup'

const mocks = vi.hoisted(() => ({
  batch: vi.fn(),
  failed: vi.fn(),
  start: vi.fn(),
  sleep: vi.fn(),
}))
vi.mock('../workflows/steps', () => ({
  processImportBatch: mocks.batch,
  recordFailedRun: mocks.failed,
}))
vi.mock('workflow/api', () => ({ start: mocks.start }))
vi.mock('workflow', () => ({ sleep: mocks.sleep }))

beforeEach(() => vi.resetAllMocks())
describe('bounded Workflow orchestration', () => {
  it('continues in a new run after 200 batches with only the job reference', async () => {
    mocks.batch.mockResolvedValue({ state: 'rows', revision: '1000', terminal: false })
    mocks.start.mockResolvedValue({ runId: 'next-run' })
    expect(await importBackup('job')).toEqual({
      jobId: 'job',
      state: 'continuing',
      nextRunId: 'next-run',
    })
    expect(mocks.batch).toHaveBeenCalledTimes(200)
    expect(mocks.start).toHaveBeenCalledWith(importBackup, ['job'])
    expect(mocks.batch.mock.calls.every((args) => JSON.stringify(args) === '["job"]')).toBe(true)
  })
  it.each(['completed', 'cancelled', 'blocked'])(
    'ends without another run when %s',
    async (state) => {
      mocks.batch.mockResolvedValue({ state, revision: '1', terminal: true })
      expect(await importBackup('job')).toEqual({ jobId: 'job', state })
      expect(mocks.start).not.toHaveBeenCalled()
    }
  )
  it('yields when another worker owns the job', async () => {
    mocks.batch
      .mockResolvedValueOnce({ state: 'busy', terminal: false })
      .mockResolvedValueOnce({ state: 'completed', terminal: true })
    await importBackup('job')
    expect(mocks.sleep).toHaveBeenCalledWith('5s')
  })
  it('records exhausted retries without exposing the original error', async () => {
    mocks.batch.mockRejectedValue(new Error('sensitive driver data'))
    await expect(importBackup('job')).rejects.toThrow('Import run stopped')
    expect(mocks.failed).toHaveBeenCalledWith('job')
  })
})
