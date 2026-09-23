import { expect, it, vi } from 'vitest'
import { FatalError } from 'workflow'

import { PlatformRetryError } from '../src/platform-retry'
import { ImportStepError } from '../src/workflow/engine'
import { processImportBatch } from '../workflows/steps'

const mocks = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('../src/workflow/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/workflow/engine')>()),
  executeImportStep: mocks.execute,
}))
it('schedules a durable Workflow retry at the provider deadline', async () => {
  const retryAt = Date.now() + 7200000
  mocks.execute.mockRejectedValue(new PlatformRetryError(429, retryAt))
  const error = await processImportBatch('job').catch((error) => error)
  expect(error.retryAfter).toEqual(new Date(retryAt))
  expect(error.message).not.toContain('secret')
})
it('keeps retries bounded for ordinary failures', async () => {
  mocks.execute.mockRejectedValue(new Error('secret driver details'))
  const started = Date.now()
  const error = await processImportBatch('job').catch((error) => error)
  expect(error.retryAfter.getTime()).toBeGreaterThanOrEqual(started + 10000)
  expect(error.retryAfter.getTime()).toBeLessThanOrEqual(Date.now() + 10000)
  expect(error.message).not.toContain('secret')
  expect(processImportBatch.maxRetries).toBe(5)
})
it.each([
  'Another job owns this target',
  'Batch receipt conflict',
  'Destination ownership or schema drift',
  'Input has not been frozen',
])('stops retrying a deterministic refusal and keeps its diagnosis (%s)', async (message) => {
  mocks.execute.mockRejectedValue(new ImportStepError(message, true))
  const error = await processImportBatch('job').catch((error) => error)
  expect(error).toBeInstanceOf(FatalError)
  expect(error.message).toBe(message)
})
it('retries a sanitized step failure that is not deterministic', async () => {
  mocks.execute.mockRejectedValue(new ImportStepError('Import step failed. Retry.', false))
  const error = await processImportBatch('job').catch((error) => error)
  expect(error).not.toBeInstanceOf(FatalError)
  expect(error.message).toBe('Import step failed. Retry.')
})
