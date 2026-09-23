import { describe, expect, it } from 'vitest'

import { batchLimits, readRowBatch, type RangeSource } from '../src/workflow/batches'

function source(bytes: Buffer): RangeSource {
  return { size: bytes.length, read: async (start, end) => bytes.subarray(start, end) }
}
describe('bounded resumable JSONL batches', () => {
  it('resumes at exact byte offsets across UTF-8 and CRLF boundaries', async () => {
    const bytes = Buffer.from('{"name":"資料"}\r\n{"name":"😀"}\n{"last":true}')
    const first = await readRowBatch(source(bytes), 0, { rows: 1, bytes: 64, recordBytes: 60 })
    expect(first.records.map((r) => r.toString())).toEqual(['{"name":"資料"}\r'])
    const second = await readRowBatch(source(bytes), first.next, {
      rows: 1,
      bytes: 64,
      recordBytes: 60,
    })
    expect(second.records[0].toString()).toBe('{"name":"😀"}')
    const third = await readRowBatch(source(bytes), second.next, {
      rows: 1,
      bytes: 64,
      recordBytes: 60,
    })
    expect(third.records[0].toString()).toBe('{"last":true}')
    expect(third.next).toBe(bytes.length)
    expect(third.done).toBe(true)
  })
  it('limits bytes independently of the number of rows', async () => {
    const value = source(Buffer.from('12345\n12345\n12345\n'))
    const batch = await readRowBatch(value, 0, { rows: 100, bytes: 12, recordBytes: 8 })
    expect(batch.records).toHaveLength(2)
    expect(batch.next).toBe(12)
  })
  it('does not download megabytes of overlapping lookahead for narrow rows', async () => {
    const record = Buffer.from('x'.repeat(99) + '\n')
    let fetched = 0
    const data: RangeSource = {
      size: 100_000_000,
      read: async (start, end) => {
        fetched += end - start
        return Buffer.from(
          Array.from({ length: end - start }, (_, i) => record[(start + i) % record.length])
        )
      },
    }
    let offset = 0
    for (let i = 0; i < 10; i++) {
      const batch = await readRowBatch(data, offset)
      expect(batch.records).toHaveLength(500)
      offset = batch.next
    }
    expect(fetched).toBeLessThan(offset * 2)
  })
  it('supports offsets beyond 4 GiB without downloading the prefix', async () => {
    const start = 5 * 1024 ** 3
    const reads: number[][] = []
    const data: RangeSource = {
      size: start + 6,
      read: async (from, to) => {
        reads.push([from, to])
        return Buffer.from('1\n2\n3\n').subarray(from - start, to - start)
      },
    }
    expect((await readRowBatch(data, start)).next).toBe(start + 6)
    expect(reads[0][0]).toBe(start)
    expect(
      reads.every(([from, to]) => to - from <= batchLimits.bytes + batchLimits.recordBytes + 1)
    ).toBe(true)
  })
  it('rejects oversized records and incomplete range responses', async () => {
    await expect(
      readRowBatch(source(Buffer.from('x'.repeat(17))), 0, { rows: 2, bytes: 16, recordBytes: 8 })
    ).rejects.toThrow(/record/i)
    await expect(readRowBatch({ size: 20, read: async () => Buffer.from('x') }, 0)).rejects.toThrow(
      /range/i
    )
  })
  it('handles empty input and never silently skips blank lines', async () => {
    expect((await readRowBatch(source(Buffer.alloc(0)), 0)).records).toEqual([])
    expect((await readRowBatch(source(Buffer.from('\n')), 0)).records[0].length).toBe(0)
  })
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe cursors: %s', async (offset) => {
    await expect(readRowBatch(source(Buffer.from('1')), offset)).rejects.toThrow()
  })
})
