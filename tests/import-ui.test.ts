import { deriveRunPayloadKeys, encryptEnvelope } from '@workflow/core/serialization-format'
import type { Client } from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  completedBatches,
  phaseState,
  retainProgress,
  type Progress,
} from '../src/client/contracts'
import { selectFiles } from '../src/client/upload'
import { decryptTarget, encryptTarget, validateConnection } from '../src/server/credentials'
import { deriveProgress, workflowProgress } from '../src/server/progress'
import {
  connectedSession,
  errorResponse,
  HttpError,
  jsonBody,
  sameOrigin,
  session,
} from '../src/server/session'

const target = {
  databaseUrl: 'postgresql://postgres:password@db.abcdefghijklmnopqrst.supabase.co:5432/postgres',
  supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
  serviceRoleKey: 'private-test-key',
}
afterEach(() => vi.unstubAllEnvs())
describe('browser destination boundary', () => {
  it('accepts a matching hosted destination', () =>
    expect(validateConnection(target, false)).toEqual(target))
  it.each([
    'postgresql://postgres:pw@169.254.169.254/postgres',
    'postgresql://postgres:pw@evil.example/postgres',
    target.databaseUrl + '?sslkey=/etc/private-key',
    target.databaseUrl + '?host=evil.example',
  ])('rejects unsafe connection %s', (databaseUrl) =>
    expect(() => validateConnection({ ...target, databaseUrl }, false)).toThrow()
  )
  it('rejects a mismatched project API', () =>
    expect(() =>
      validateConnection(
        { ...target, supabaseUrl: 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co' },
        false
      )
    ).toThrow())
  it('allows loopback only in explicit local mode', () => {
    const local = {
      ...target,
      databaseUrl: 'postgresql://postgres:pw@127.0.0.1:57322/postgres',
      supabaseUrl: 'http://127.0.0.1:57321',
    }
    expect(() => validateConnection(local, false)).toThrow()
    expect(validateConnection(local, true)).toEqual(local)
  })
  it('encrypts credentials and binds ciphertext to its job', () => {
    vi.stubEnv('IMPORT_CREDENTIAL_KEY', Buffer.alloc(32, 5).toString('base64'))
    const encrypted = encryptTarget('job-a', target)
    expect(encrypted.includes(Buffer.from('password'))).toBe(false)
    expect(decryptTarget('job-a', encrypted)).toEqual(target)
    expect(() => decryptTarget('job-b', encrypted)).toThrow()
    encrypted[20] ^= 1
    expect(() => decryptTarget('job-a', encrypted)).toThrow()
  })
})
describe('raw folder selection', () => {
  const f = (path: string) =>
    ({ webkitRelativePath: path, name: path.split('/').at(-1)!, size: 0 }) as File
  it('removes one selected directory prefix and keeps empty files', () =>
    expect(
      selectFiles([f('backup/config.json'), f('backup/entities/tasks.jsonl')]).map((f) => f.path)
    ).toEqual(['config.json', 'entities/tasks.jsonl']))
  it.each(
    [
      ['backup.zip'],
      ['backup/config.json', 'backup/../secret'],
      ['config.json', 'entities/a.jsonl', 'entities/A.jsonl'],
      ['entities/a.jsonl'],
    ].map((paths) => ({ paths }))
  )('rejects invalid selection $paths', ({ paths }) =>
    expect(() => selectFiles(paths.map(f))).toThrow()
  )
})
describe('Workflow-derived progress', () => {
  const previous = { jobId: 'job', status: 'running', phase: 'rows', revision: '201' } as Progress
  it('keeps confirmed progress during run rotation while preserving retry status', () => {
    expect(
      retainProgress(previous, {
        ...previous,
        runId: 'next',
        phase: null,
        revision: null,
        retrying: true,
      })
    ).toMatchObject({ runId: 'next', phase: 'rows', revision: '201', retrying: true })
  })
  it('does not regress checkpoints, but accepts later ones and terminal results', () => {
    expect(retainProgress(previous, { ...previous, phase: 'files', revision: '150' }).phase).toBe(
      'rows'
    )
    expect(retainProgress(previous, { ...previous, phase: 'links', revision: '202' }).phase).toBe(
      'links'
    )
    expect(
      retainProgress(previous, {
        ...previous,
        phase: 'completed',
        status: 'completed',
        revision: null,
      }).phase
    ).toBe('completed')
    expect(
      retainProgress(previous, { ...previous, jobId: 'other', phase: null, revision: null }).phase
    ).toBeNull()
  })
  it('counts saved batches without counting initialization or losing bigint precision', () => {
    expect(completedBatches('1')).toBe('0')
    expect(completedBatches('201')).toBe('200')
    expect(completedBatches('9007199254740993')).toBe('9,007,199,254,740,992')
    expect(completedBatches(null)).toBeNull()
    expect(completedBatches('invalid')).toBeNull()
  })
  it('selects the highest completed import revision, ignoring unrelated output', () => {
    const result = deriveProgress('running', [
      {
        status: 'completed',
        output: { state: 'rows', revision: '99', terminal: false },
        attempt: 1,
      },
      { status: 'completed', output: { state: 'analyzing', revision: '8' }, attempt: 1 },
      { status: 'running', attempt: 2 },
    ])
    expect(result).toMatchObject({ phase: 'rows', revision: '99', retrying: true, attempt: 2 })
  })
  it('does not declare success until the Workflow run completes', () =>
    expect(
      deriveProgress('running', [
        { status: 'completed', output: { state: 'completed', revision: '100' }, attempt: 1 },
      ]).status
    ).toBe('running'))
  it('uses SDK failure and cancellation even after successful batches', () => {
    expect(deriveProgress('failed', []).status).toBe('failed')
    expect(deriveProgress('cancelled', []).status).toBe('cancelled')
  })
  it('does not infer a phase from incomplete steps or an unrelated output', () =>
    expect(
      deriveProgress('pending', [
        { status: 'running', output: { state: 'rows', revision: '5' }, attempt: 1 },
        { status: 'completed', output: { token: 'secret' }, attempt: 1 },
      ]).phase
    ).toBeNull())
  it('marks prior phases complete without fabricating an overall percentage', () => {
    expect(phaseState('rows', 'schema', 'running')).toBe('completed')
    expect(phaseState('rows', 'rows', 'failed')).toBe('active')
    expect(phaseState(null, 'rows', 'pending')).toBe('pending')
  })
})

describe('browser session and request boundary', () => {
  it('creates an opaque secure HttpOnly session and recovers its owner', () => {
    const owner = session(new Request('https://import.example'), true)
    expect(owner.cookie).toContain('HttpOnly; SameSite=Strict')
    expect(owner.cookie).toContain('; Secure')
    const recovered = session(
      new Request('https://import.example', { headers: { cookie: owner.cookie! } })
    )
    expect(recovered.hash).toBe(owner.hash)
    expect(recovered.cookie).toBeNull()
    expect(owner.hash).not.toContain(owner.cookie!.split('=')[1].split(';')[0])
  })
  it('keeps Secure when a TLS-terminating proxy hands Next an http URL', () => {
    vi.stubEnv('IMPORT_OAUTH_CLIENT_ID', 'client')
    vi.stubEnv('IMPORT_OAUTH_CLIENT_SECRET', 'private-secret')
    vi.stubEnv(
      'IMPORT_OAUTH_REDIRECT_URI',
      'https://import.example/migrate/instantdb/api/supabase/callback'
    )
    expect(session(new Request('http://import.example'), true).cookie).toContain('; Secure')
  })
  it('asks an unconnected browser to connect instead of reporting a missing import', () => {
    try {
      connectedSession(new Request('http://localhost'))
      expect.unreachable('a cookieless browser owns no import')
    } catch (error) {
      expect((error as HttpError).status).toBe(401)
      expect((error as HttpError).message).toBe('Connect Supabase before starting an import')
    }
    const owner = session(new Request('http://localhost'), true)
    expect(
      connectedSession(new Request('http://localhost', { headers: { cookie: owner.cookie! } })).hash
    ).toBe(owner.hash)
  })
  it('rejects missing sessions and cross-origin mutations', () => {
    expect(() => session(new Request('http://localhost'))).toThrow(HttpError)
    expect(() =>
      sameOrigin(new Request('http://localhost', { headers: { origin: 'http://other.example' } }))
    ).toThrow(HttpError)
    expect(() =>
      sameOrigin(new Request('http://localhost', { headers: { origin: 'http://localhost' } }))
    ).not.toThrow()
  })
  it('bounds JSON input even without a Content-Length header', async () => {
    const request = new Request('http://localhost', { method: 'POST', body: '1234567890' })
    await expect(jsonBody(request, 5)).rejects.toMatchObject({ status: 413 })
    await expect(
      jsonBody(new Request('http://localhost', { method: 'POST', body: '{bad' }))
    ).rejects.toMatchObject({ status: 400 })
  })
  it('never returns raw database or credential errors', async () => {
    const result = errorResponse(new Error('password=private-secret'))
    expect(result.status).toBe(503)
    expect(await result.text()).not.toContain('private-secret')
  })
})

it('checks the browser-facing Host when Next normalizes the internal request URL', () => {
  expect(() =>
    sameOrigin(
      new Request('http://localhost:3009/api/browser-imports', {
        headers: { host: '127.0.0.1:3009', origin: 'http://127.0.0.1:3009' },
      })
    )
  ).not.toThrow()
})

it('accepts the configured callback origin when a proxy rewrites Host', () => {
  vi.stubEnv('IMPORT_OAUTH_CLIENT_ID', 'client')
  vi.stubEnv('IMPORT_OAUTH_CLIENT_SECRET', 'private-secret')
  vi.stubEnv(
    'IMPORT_OAUTH_REDIRECT_URI',
    'https://supabase.example/migrate/instantdb/api/supabase/callback'
  )
  const proxied = (origin: string) =>
    new Request('https://importer.example/migrate/instantdb/api/browser-imports', {
      headers: { host: 'importer.example', origin },
    })
  expect(() => sameOrigin(proxied('https://supabase.example'))).not.toThrow()
  expect(() => sameOrigin(proxied('https://importer.example'))).not.toThrow()
  expect(() => sameOrigin(proxied('https://other.example'))).toThrow(HttpError)
})

const sdk = vi.hoisted(() => ({ getRun: vi.fn(), list: vi.fn(), run: vi.fn(), key: vi.fn() }))
vi.mock('workflow/api', () => ({ getRun: sdk.getRun }))
vi.mock('workflow/runtime', () => ({
  getWorld: async () => ({
    steps: { list: sdk.list },
    runs: { get: sdk.run },
    getEncryptionKeyForRun: sdk.key,
  }),
}))

describe('Workflow SDK progress adapter', () => {
  it('reads real encrypted production step output and exposes only progress', async () => {
    const rawKey = new Uint8Array(32).fill(7)
    const output = await encryptEnvelope(
      new TextEncoder().encode(
        'devl' +
          JSON.stringify([
            { state: 1, revision: 2, terminal: 3, secret: 4 },
            'rows',
            '201',
            false,
            'private',
          ])
      ),
      await deriveRunPayloadKeys(rawKey)
    )
    sdk.getRun.mockReturnValue({
      status: Promise.resolve('running'),
      startedAt: Promise.resolve(undefined),
    })
    const run = { runId: 'encrypted', workflowEncryptionEnabled: true }
    sdk.run.mockResolvedValue(run)
    sdk.key.mockResolvedValue(rawKey)
    sdk.list.mockResolvedValue({
      data: [
        {
          stepId: 'step-1',
          stepName: 'step//./workflows/steps//processImportBatch',
          status: 'completed',
          output,
          attempt: 1,
        },
      ],
    })
    const result = await workflowProgress({} as Client, 'job', 'encrypted')
    expect(result).toMatchObject({ phase: 'rows', revision: '201', status: 'running' })
    expect(sdk.key).toHaveBeenCalledWith(run)
    expect(JSON.stringify(result)).not.toContain('private')
    sdk.key.mockResolvedValue(undefined)
    await expect(workflowProgress({} as Client, 'job', 'encrypted')).rejects.toThrow('progress')
  })
  it('follows continuation runs and only returns import step progress', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    sdk.getRun.mockImplementation((id: string) =>
      id === 'first'
        ? {
            status: Promise.resolve('completed'),
            returnValue: Promise.resolve({
              jobId: 'job',
              state: 'continuing',
              nextRunId: 'second',
            }),
          }
        : {
            status: Promise.resolve('running'),
            startedAt: Promise.resolve(new Date('2026-09-07T00:00:00Z')),
          }
    )
    sdk.list.mockResolvedValue({
      data: [
        {
          stepName: 'steps//processImportBatch',
          status: 'completed',
          output: { state: 'rows', revision: '201' },
          attempt: 1,
        },
        {
          stepName: 'other',
          status: 'completed',
          output: { state: 'completed', revision: '999', secret: 'private' },
          attempt: 1,
        },
      ],
    })
    const result = await workflowProgress({ query } as unknown as Client, 'job', 'first')
    expect(result).toMatchObject({
      runId: 'second',
      status: 'running',
      phase: 'rows',
      revision: '201',
    })
    expect(query).toHaveBeenCalledOnce()
    expect(sdk.list).toHaveBeenCalledWith({
      runId: 'second',
      pagination: { limit: 50, sortOrder: 'desc' },
      resolveData: 'all',
    })
    expect(JSON.stringify(result)).not.toContain('private')
  })
  it('rejects a continuation belonging to a different job', async () => {
    sdk.getRun.mockReturnValue({
      status: Promise.resolve('completed'),
      returnValue: Promise.resolve({ jobId: 'other', state: 'completed' }),
    })
    await expect(workflowProgress({} as Client, 'job', 'first')).rejects.toThrow(
      'Workflow job mismatch'
    )
  })
  it('uses the final workflow return value for cancellation', async () => {
    sdk.getRun.mockReturnValue({
      status: Promise.resolve('completed'),
      startedAt: Promise.resolve(undefined),
      returnValue: Promise.resolve({ jobId: 'job', state: 'cancelled' }),
    })
    expect(await workflowProgress({} as Client, 'job', 'first')).toMatchObject({
      status: 'cancelled',
      phase: 'cancelled',
    })
  })
})
