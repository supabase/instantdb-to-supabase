import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { safeSql } from '@supabase/pg-meta'

import { executeImportStep } from '../src/workflow/engine'
import { connectStore, getJob } from '../src/workflow/store'
import { uploadFolder } from '../src/workflow/upload'

// Do not print driver errors, source rows, or credentials. The pipeline sanitizes its own
// messages; anything carrying driver metadata stays unprinted.
function report(error: unknown) {
  if (error instanceof Error && !('code' in error) && !('details' in error))
    process.stderr.write(`${error.message}\n`)
}
async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      target: { type: 'string' },
      job: { type: 'string' },
      'run-local': { type: 'boolean' },
      output: { type: 'string' },
    },
  })
  const id =
    values.input && values.target
      ? await uploadFolder(resolve(values.input), values.target, values.job, (jobId) => {
          process.stdout.write(JSON.stringify({ jobId, state: 'uploading' }) + '\n')
        })
      : values.job
  if (!id) throw new Error('Pass --input and --target, or --job')
  process.stdout.write(JSON.stringify({ jobId: id }) + '\n')
  if (values['run-local']) {
    // Bounded so a job another worker holds, or one that stops making progress, still exits.
    let remaining = 100_000
    for (;;) {
      if (remaining-- <= 0) throw new Error('Local run exceeded its step budget')
      const result = await executeImportStep(id, undefined, report)
      if (result.terminal) break
      // Another worker holds the advisory lock; poll instead of reconnecting in a tight loop.
      if (result.state === 'busy') await delay(5000)
    }
  }
  const db = await connectStore()
  try {
    const job = await getJob(db, id)
    if (values.output) {
      const directory = resolve(values.output, id)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const artifacts = await db.query(
        safeSql`SELECT name,bytes FROM instant_import_service.artifacts WHERE job_id=$1`,
        [id]
      )
      for (const artifact of artifacts.rows) {
        const path = resolve(directory, artifact.name)
        if (!path.startsWith(directory + '/')) throw new Error('Invalid artifact path')
        await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 })
        await writeFile(path, artifact.bytes, { mode: 0o600 })
      }
    }
    process.stdout.write(
      JSON.stringify({
        jobId: id,
        state: job.phase,
        revision: job.revision,
        errorCode: job.error_code,
      }) + '\n'
    )
    // A terminal job that did not complete is not a successful import, even though the CLI
    // ran cleanly. An upload-only invocation leaves the job mid-pipeline and still succeeds.
    if (['blocked', 'cancelled'].includes(job.phase)) process.exitCode = 1
  } finally {
    await db.end()
  }
}
main().catch((error) => {
  process.stderr.write(
    'Workflow import stopped. Inspect the durable job and retry with the same input.\n'
  )
  report(error)
  process.exitCode = 1
})
