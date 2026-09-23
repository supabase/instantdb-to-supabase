import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { readBackupFolder, validatePath } from '../src/import/input'
import { entries } from './fixtures'

const folders: string[] = []
async function folder() {
  const root = await mkdtemp(join(tmpdir(), 'instant-input-'))
  folders.push(root)
  await mkdir(join(root, 'entities'))
  for (const [path, bytes] of entries()) await writeFile(join(root, path), bytes)
  return root
}
afterEach(async () => {
  for (const root of folders.splice(0)) await rm(root, { recursive: true, force: true })
})
describe('extracted backup boundary', () => {
  it('reads raw files with exact relative names and bytes', async () =>
    expect(await readBackupFolder(await folder())).toEqual(entries()))
  it.each([
    '../config.json',
    '/config.json',
    'C:/config.json',
    'entities/../config.json',
    'entities\\people.jsonl',
    'entities//people.jsonl',
    'files/./abc',
  ])('rejects unsafe path %s', (path) => expect(() => validatePath(path)).toThrow())
  it('rejects symlinks', async () => {
    const root = await folder()
    await symlink(join(root, 'config.json'), join(root, 'alias'))
    await expect(readBackupFolder(root)).rejects.toThrow(/symlink/i)
  })
  it('enforces byte limits', async () =>
    await expect(readBackupFolder(await folder(), { maxExpandedBytes: 20 })).rejects.toThrow(
      /limit/i
    ))
  it('rejects unexpected directories', async () => {
    const root = await folder()
    await mkdir(join(root, 'other'))
    await expect(readBackupFolder(root)).rejects.toThrow(/directory/i)
  })
  it('reads the __MACOSX tree but rejects lookalike directories', async () => {
    const root = await folder()
    await mkdir(join(root, '__MACOSX'))
    await writeFile(join(root, '__MACOSX', 'ignored'), 'x')
    expect((await readBackupFolder(root)).has('__MACOSX/ignored')).toBe(true)
    await mkdir(join(root, '__MACOSX_notes'))
    await expect(readBackupFolder(root)).rejects.toThrow(/directory/i)
  })
  it('rejects entry count limit', async () =>
    await expect(readBackupFolder(await folder(), { maxEntries: 1 })).rejects.toThrow(/limit/i))
})
