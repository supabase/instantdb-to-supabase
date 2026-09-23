import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = path.join(root, 'vendor/upstream.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const args = process.argv.slice(2)
const digest = (data) => createHash('sha256').update(data).digest('hex')
const inside = (relative) => {
  const resolved = path.resolve(root, relative)
  if (!resolved.startsWith(root + path.sep)) throw new Error('Invalid snapshot path')
  return resolved
}
const changed = manifest.files.filter(
  (file) => digest(readFileSync(inside(file.path))) !== file.sha256
)
if (changed.length)
  throw new Error(
    `Snapshot differs: ${changed.map((file) => file.path).join(', ')}. Preserve local changes before updating.`
  )
if (args.length === 1 && args[0] === '--check') {
  console.log(`Verified ${manifest.files.length} upstream files from ${manifest.commit}.`)
} else {
  if (
    args.length !== 4 ||
    args[0] !== '--source' ||
    args[2] !== '--ref' ||
    !/^[a-f0-9]{40}$/.test(args[3])
  ) {
    throw new Error(
      'Usage: pnpm vendor:sync --source /path/to/supabase --ref FULL_COMMIT_SHA (or pnpm vendor:check)'
    )
  }
  // Stage all reads before writing. Missing upstream paths must not leave a partial sync.
  const files = manifest.files.map((file) => ({
    ...file,
    bytes: execFileSync('git', ['-C', args[1], 'show', `${args[3]}:${file.source}`], {
      maxBuffer: 16 * 1024 * 1024,
    }),
  }))
  for (const file of files) writeFileSync(inside(file.path), file.bytes)
  manifest.commit = args[3]
  manifest.files = files.map(({ bytes, ...file }) => ({ ...file, sha256: digest(bytes) }))
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  console.log(
    'Updated snapshot. Review imports, dependencies, licenses, and the diff; then run the full checks before committing.'
  )
}
