import { afterEach, expect, it, vi } from 'vitest'

import { authorized } from '../src/workflow/api-auth'

afterEach(() => vi.unstubAllEnvs())
it.each([undefined, '', 'Bearer wrong', 'Basic private-token', 'Bearer private-token-extra'])(
  'rejects invalid authorization: %s',
  (header) => {
    vi.stubEnv('IMPORT_WORKFLOW_TOKEN', 'private-token')
    expect(
      authorized(
        new Request('https://app.example', { headers: header ? { Authorization: header } : {} })
      )
    ).toBe(false)
  }
)
it('accepts the exact operator token', () => {
  vi.stubEnv('IMPORT_WORKFLOW_TOKEN', 'private-token')
  expect(
    authorized(
      new Request('https://app.example', { headers: { Authorization: 'Bearer private-token' } })
    )
  ).toBe(true)
})
it('denies all callers when the operator token is not configured', () => {
  vi.stubEnv('IMPORT_WORKFLOW_TOKEN', '')
  expect(
    authorized(new Request('https://app.example', { headers: { Authorization: 'Bearer ' } }))
  ).toBe(false)
})
