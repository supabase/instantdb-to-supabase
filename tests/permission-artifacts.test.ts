import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { entries } from './fixtures'

const folders: string[] = []
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true })
})

describe('permission artifacts from the real CLI', () => {
  it('writes SQL and a complete restricted report without printing rule literals or applying permissions', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'permission-artifact-test-'))
    folders.push(folder)
    const input = entries(),
      config = JSON.parse(input.get('config.json')!.toString())
    const secret = 'private-rule-value-not-for-logs'
    config.rules = {
      $default: { allow: { $default: 'false' } },
      people: { allow: { view: `ruleParams.token == '${secret}'` } },
      empty: { allow: { view: 'true' } },
    }
    input.set('config.json', Buffer.from(JSON.stringify(config)))
    await mkdir(join(folder, 'input', 'entities'), { recursive: true })
    for (const [path, data] of input) await writeFile(join(folder, 'input', path), data)
    const run = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/import.ts',
        '--input',
        join(folder, 'input'),
        '--output',
        join(folder, 'output'),
      ],
      { encoding: 'utf8' }
    )
    expect(run.status, run.stderr).toBe(0)
    const result = JSON.parse(run.stdout)
    expect(result.permissions.applied).toBe(false)
    expect(result.permissions.manual).toBeTypeOf('number')
    expect(run.stdout).not.toContain(secret)
    expect(run.stderr).not.toContain(secret)
    const report = JSON.parse(await readFile(join(result.artifacts, 'permissions.json'), 'utf8'))
    expect(report.sourceRules).toEqual(config.rules)
    expect(report.statements).toBeUndefined()
    expect(
      report.rules.find(
        (r: { namespace: string; action: string }) =>
          r.namespace === 'people' && r.action === 'view'
      ).status
    ).toBe('manual')
    expect(await readFile(join(result.artifacts, 'permissions-manual.md'), 'utf8')).toContain(
      secret
    )
    const sql = await readFile(join(result.artifacts, 'permissions.sql'), 'utf8')
    expect(sql).toContain('FOR SELECT')
    expect(sql).not.toContain(secret)
    for (const name of ['permissions.json', 'permissions-manual.md', 'permissions.sql'])
      expect((await stat(join(result.artifacts, name))).mode & 0o777).toBe(0o600)
  })
})
