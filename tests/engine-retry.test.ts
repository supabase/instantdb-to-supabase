import { beforeEach, expect, it, vi } from 'vitest'

import { PlatformRetryError } from '../src/platform-retry'
import { executeImportStep, ImportStepError } from '../src/workflow/engine'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  end: vi.fn(),
  target: vi.fn(),
  owner: { acquired: true, job_id: 'job' },
}))
vi.mock('../src/workflow/store', () => ({
  connectStore: async () => ({ query: mocks.query, end: mocks.end }),
  getJob: async () => ({ id: 'job', phase: 'schema', target_ref: 'target', model: 'plan' }),
  unpackPlan: () => ({}),
}))
vi.mock('../src/server/credentials', () => ({ connectJobTarget: mocks.target }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.owner.job_id = 'job'
  mocks.query.mockImplementation(async () => ({ rows: [mocks.owner] }))
})
it('releases the service transaction and preserves only safe retry metadata', async () => {
  const error = new PlatformRetryError(429, Date.now() + 120000)
  mocks.target.mockRejectedValue(error)
  await expect(executeImportStep('job')).rejects.toBe(error)
  expect(mocks.query.mock.calls.flat()).toContain('ROLLBACK')
  expect(mocks.end).toHaveBeenCalledOnce()
})
it('reports a deterministic refusal as fatal so a step does not spend its retries', async () => {
  mocks.owner.job_id = 'other'
  const error = await executeImportStep('job').catch((error) => error)
  expect(error).toBeInstanceOf(ImportStepError)
  expect(error).toMatchObject({ fatal: true, message: 'Another job owns this target' })
})
it('keeps driver text out of a retryable failure', async () => {
  mocks.target.mockRejectedValue(new Error('secret driver details'))
  const error = await executeImportStep('job').catch((error) => error)
  expect(error).toBeInstanceOf(ImportStepError)
  expect(error.fatal).toBe(false)
  expect(error.message).not.toContain('secret')
})
it('does not let a failed rollback replace the original failure', async () => {
  mocks.target.mockRejectedValue(new Error('driver details'))
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql === 'ROLLBACK') throw new Error('connection terminated')
    return { rows: [mocks.owner] }
  })
  const error = await executeImportStep('job').catch((error) => error)
  expect(error.message).not.toContain('connection terminated')
  expect(error).toBeInstanceOf(ImportStepError)
})
