import { beforeEach, describe, expect, it, vi } from 'vitest'

import { compilePermissions, permissionsSql } from '../src/import/permissions'
import { analyze } from '../src/import/plan'
import { browserHandoff } from '../src/server/handoff'
import { digest } from '../src/server/session'
import { entries } from './fixtures'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  end: vi.fn(),
  getJob: vi.fn(),
  unpackPlan: vi.fn(),
  target: vi.fn(),
  progress: vi.fn(),
}))
vi.mock('../src/workflow/store', () => ({
  connectStore: async () => mocks,
  getJob: mocks.getJob,
  unpackPlan: mocks.unpackPlan,
}))
vi.mock('../src/server/credentials', () => ({ jobDestination: mocks.target }))
vi.mock('../src/server/progress', () => ({ workflowProgress: mocks.progress }))
const id = '00000000-0000-4000-8000-000000000001',
  token = 'a'.repeat(43)
const request = (query = '', cookie = token) =>
  new Request(`http://localhost:3009/api/browser-imports/${id}/handoff${query}`, {
    headers: cookie ? { cookie: `instant-import-session=${cookie}` } : {},
  })
beforeEach(() => {
  vi.clearAllMocks()
  mocks.query.mockImplementation(async (sql: string, params: unknown[]) =>
    sql.includes('session_hash')
      ? { rowCount: params[1] === digest(token) ? 1 : 0, rows: [{ run_id: 'run-1' }] }
      : sql.includes("name='permissions.sql'")
        ? { rows: [{ bytes: Buffer.from(permissionsSql(compilePermissions(mocks.unpackPlan()))) }] }
        : { rows: [{ bytes: Buffer.from('{"permissionsApplied":true}') }] }
  )
  mocks.getJob.mockResolvedValue({ id, model: Buffer.alloc(1) })
  mocks.unpackPlan.mockReturnValue(analyze(entries()))
  mocks.target.mockResolvedValue({
    supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
    databaseUrl: 'private-database',
    serviceRoleKey: 'private-key',
  })
  mocks.progress.mockResolvedValue({ status: 'completed' })
})
describe('private completion handoff endpoint', () => {
  it.each(['', 'b'.repeat(43)])('requires the original browser session', async (cookie) => {
    const result = await browserHandoff(request('', cookie), id)
    expect(result.status).toBe(404)
    expect(mocks.target).not.toHaveBeenCalled()
    expect(mocks.end).toHaveBeenCalled()
  })
  it.each(['running', 'failed', 'cancelled', 'pending'])(
    'waits for Workflow completion: %s',
    async (status) => {
      mocks.progress.mockResolvedValue({ status })
      expect((await browserHandoff(request(), id)).status).toBe(409)
      expect(mocks.target).not.toHaveBeenCalled()
    }
  )
  it('returns no credentials, rows or full prompts in the overview', async () => {
    const response = await browserHandoff(request(), id)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const body = await response.text()
    for (const secret of ['private-key', 'private-database', 'createdAt', 'sourceRules'])
      expect(body).not.toContain(secret)
  })
  it('only confirms deletion when the completion report records it', async () => {
    expect(await (await browserHandoff(request(), id)).json()).toMatchObject({
      backupDeleted: false,
    })
    const originalQuery = mocks.query.getMockImplementation()!
    mocks.query.mockImplementation((sql, params) =>
      sql.includes("name='verification.json'")
        ? { rows: [{ bytes: Buffer.from('{"permissionsApplied":true,"backupDeleted":true}') }] }
        : originalQuery(sql, params)
    )
    expect(await (await browserHandoff(request(), id)).json()).toMatchObject({
      backupDeleted: true,
    })
  })
  it('loads an individual prompt and rejects unknown item IDs', async () => {
    expect((await browserHandoff(request('?item=application'), id)).status).toBe(200)
    expect((await browserHandoff(request('?item=../../../credentials'), id)).status).toBe(404)
  })
  it('loads converted rule details on demand and rejects invalid or ambiguous requests', async () => {
    const plan = analyze(entries())
    const config = JSON.parse(plan.config.toString())
    config.rules = {}
    plan.config = Buffer.from(JSON.stringify(config))
    mocks.unpackPlan.mockReturnValue(plan)
    const overview = await (await browserHandoff(request(), id)).json()
    const rule = overview.convertedRules[0]
    const response = await browserHandoff(request(`?rule=${rule.id}`), id)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toMatchObject({
      expression: 'true',
      source: 'implicit default (true)',
      sql: {
        policy: expect.stringContaining('CREATE POLICY'),
        supporting: expect.stringContaining('GRANT'),
      },
    })
    expect((await browserHandoff(request('?rule=missing'), id)).status).toBe(404)
    expect((await browserHandoff(request(`?rule=${rule.id}&item=application`), id)).status).toBe(
      400
    )
    expect((await browserHandoff(request(`?rule=${rule.id}`, 'b'.repeat(43)), id)).status).toBe(404)
  })
  it.each(['missing', 'legacy'])(
    'does not show SQL as applied when the record is %s',
    async (state) => {
      const plan = analyze(entries()),
        config = JSON.parse(plan.config.toString())
      config.rules = {}
      plan.config = Buffer.from(JSON.stringify(config))
      mocks.unpackPlan.mockReturnValue(plan)
      const originalQuery = mocks.query.getMockImplementation()!
      mocks.query.mockImplementation((sql, params) =>
        sql.includes("name='permissions.sql'")
          ? { rows: [] }
          : state === 'legacy' && sql.includes("name='verification.json'")
            ? { rows: [{ bytes: Buffer.from('{"permissionsApplied":false}') }] }
            : originalQuery(sql, params)
      )
      const overview = await (await browserHandoff(request(), id)).json()
      const response = await browserHandoff(request(`?rule=${overview.convertedRules[0].id}`), id)
      expect(response.status).toBe(200)
      expect((await response.json()).sql).toBeNull()
    }
  )
  it('keeps internal errors and credentials out of responses', async () => {
    mocks.target.mockRejectedValue(new Error('private-database'))
    const response = await browserHandoff(request(), id)
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('private-database')
    expect(mocks.end).toHaveBeenCalled()
  })
})
