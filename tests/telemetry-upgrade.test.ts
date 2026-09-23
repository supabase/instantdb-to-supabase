import type { Client } from 'pg'
import { beforeEach, expect, it, vi } from 'vitest'

import { ensureStore } from '../src/server/store-ready'

const initialize = vi.hoisted(() => vi.fn())
vi.mock('../src/workflow/store', () => ({ initializeStore: initialize }))
beforeEach(() => initialize.mockReset())
it.each([
  { relation: null, telemetry_ready: false },
  { relation: 'oauth_connections', telemetry_ready: false },
])('initializes missing telemetry schema for $relation', async (row) => {
  const db = { query: vi.fn().mockResolvedValue({ rows: [row] }) } as unknown as Client
  await ensureStore(db)
  expect(initialize).toHaveBeenCalledWith(db)
})
it('does not repeat DDL after the telemetry column is available', async () => {
  await ensureStore({
    query: vi
      .fn()
      .mockResolvedValue({ rows: [{ relation: 'oauth_connections', telemetry_ready: true }] }),
  } as unknown as Client)
  expect(initialize).not.toHaveBeenCalled()
})
