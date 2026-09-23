import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createSHA256 } from 'hash-wasm'

import { readRowBatch } from '../src/workflow/batches'

const { values } = parseArgs({ options: { gib: { type: 'string', default: '2' } } })
const gib = Number(values.gib)
if (!Number.isInteger(gib) || gib < 1 || gib > 16) throw new Error('Choose 1–16 GiB')
const directory = await mkdtemp(join(tmpdir(), 'import-reader-benchmark-'))
try {
  const file = await open(join(directory, 'rows.jsonl'), 'w+')
  try {
    // Fixed-size valid JSONL records make the expected boundaries independent of the reader.
    const record = Buffer.from(JSON.stringify({ value: 'x'.repeat(8192 - 13) }) + '\n')
    if (record.length !== 8192) throw new Error('Benchmark record size mismatch')
    const block = Buffer.concat(Array.from({ length: 768 }, () => record))
    const size = gib * 1024 ** 3
    for (let offset = 0; offset < size; offset += block.length)
      await file.write(block.subarray(0, Math.min(block.length, size - offset)))
    let offset = 0,
      rows = 0,
      batches = 0,
      peakRss = 0,
      maxRead = 0
    let state: Uint8Array | undefined
    const started = performance.now()
    while (offset < size) {
      const batch = await readRowBatch(
        {
          size,
          read: async (start, end) => {
            maxRead = Math.max(maxRead, end - start)
            const buffer = Buffer.alloc(end - start)
            const result = await file.read(buffer, 0, buffer.length, start)
            return buffer.subarray(0, result.bytesRead)
          },
        },
        offset
      )
      const digest = await createSHA256()
      if (state) digest.load(state)
      digest.update(batch.consumed)
      state = digest.save()
      offset = batch.next
      rows += batch.records.length
      batches++
      peakRss = Math.max(peakRss, process.memoryUsage().rss)
    }
    if (offset !== size || rows !== size / record.length)
      throw new Error('Benchmark count mismatch')
    process.stdout.write(
      JSON.stringify({
        bytes: size,
        rows,
        batches,
        maxReadBytes: maxRead,
        peakRssBytes: peakRss,
        seconds: (performance.now() - started) / 1000,
      }) + '\n'
    )
  } finally {
    await file.close()
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}
