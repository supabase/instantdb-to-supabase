import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

export const limits = {
  maxExpandedBytes: 128 * 1024 * 1024,
  maxEntryBytes: 32 * 1024 * 1024,
  maxEntries: 10_000,
}
export const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

export function validatePath(path: string) {
  if (
    !path ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    /^[a-z]:/i.test(path) ||
    path.split('/').some((x) => !x || x === '.' || x === '..')
  ) {
    throw new Error('Invalid backup path. Select the folder containing config.json.')
  }
}

/** Read a bounded, extracted backup. Relative paths never become output paths. */
export async function readBackupFolder(root: string, overrides: Partial<typeof limits> = {}) {
  const budget = { ...limits, ...overrides }
  if (!(await lstat(root)).isDirectory()) throw new Error('Select an extracted backup folder')
  const base = await realpath(root)
  const entries = new Map<string, Buffer>()
  const seen = new Set<string>()
  let total = 0,
    count = 0
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      // relative() yields platform separators; backup keys are always POSIX-style.
      const key = relative(base, path).split(sep).join('/')
      validatePath(key)
      const normalized = key.normalize('NFC').toLowerCase()
      if (seen.has(normalized)) throw new Error('Backup path collision')
      seen.add(normalized)
      if (++count > budget.maxEntries) throw new Error('Backup entry limit exceeded')
      if (entry.isSymbolicLink()) throw new Error('Symlinks are not supported in backups')
      if (entry.isDirectory()) {
        // Mirror the packaging-metadata rule in plan.ts: only the __MACOSX tree itself.
        if (
          key !== 'entities' &&
          key !== 'files' &&
          key !== '__MACOSX' &&
          !key.startsWith('__MACOSX/')
        )
          throw new Error('Unexpected backup directory')
        await walk(path)
      } else {
        if (!entry.isFile()) throw new Error('Unsupported backup file type')
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const before = await handle.stat()
          if (
            !before.isFile() ||
            before.size > budget.maxEntryBytes ||
            total + before.size > budget.maxExpandedBytes
          )
            throw new Error('Backup byte limit exceeded')
          const chunks: Buffer[] = []
          let size = 0
          for await (const chunk of handle.createReadStream({ autoClose: false })) {
            const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
            size += bytes.length
            total += bytes.length
            if (size > budget.maxEntryBytes || total > budget.maxExpandedBytes)
              throw new Error('Backup byte limit exceeded')
            chunks.push(bytes)
          }
          const after = await handle.stat()
          if (
            size !== before.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs
          )
            throw new Error('Backup changed during reading. Retry with a stable copy.')
          entries.set(key, Buffer.concat(chunks))
        } finally {
          await handle.close()
        }
      }
    }
  }
  await walk(base)
  return entries
}
