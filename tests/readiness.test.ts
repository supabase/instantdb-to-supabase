import { afterEach, expect, it, vi } from 'vitest'

import { supabaseConnection } from '../src/server/oauth'

const required = [
  'IMPORT_JOB_DATABASE_URL',
  'IMPORT_JOB_SUPABASE_URL',
  'IMPORT_JOB_SERVICE_ROLE_KEY',
  'IMPORT_CREDENTIAL_KEY',
]
afterEach(() => vi.unstubAllEnvs())

it.each(required)('checks %s at request time without exposing its value', async (missing) => {
  vi.stubEnv('IMPORT_OAUTH_CLIENT_ID', '')
  for (const name of required) vi.stubEnv(name, 'private-test-value')
  const request = new Request('http://localhost/api/supabase/connection')
  const ready = await supabaseConnection(request)
  expect(ready.headers.get('Cache-Control')).toBe('no-store')
  expect(await ready.json()).toEqual({
    ready: true,
    configured: false,
    connected: false,
    projects: [],
  })
  vi.stubEnv(missing, '')
  expect(await (await supabaseConnection(request)).json()).toEqual({
    ready: false,
    configured: false,
    connected: false,
    projects: [],
  })
})
