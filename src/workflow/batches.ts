/** These limits bound a step's input, not the size of a backup or namespace. */
export const batchLimits = { rows: 500, bytes: 2 * 1024 * 1024, recordBytes: 1024 * 1024 }
export type RangeSource = {
  size: number
  read(start: number, endExclusive: number): Promise<Buffer>
}
export async function readRowBatch(source: RangeSource, offset: number, limits = batchLimits) {
  if (
    !Number.isSafeInteger(source.size) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > source.size ||
    !Number.isSafeInteger(limits.rows) ||
    limits.rows < 1 ||
    !Number.isSafeInteger(limits.recordBytes) ||
    !Number.isSafeInteger(limits.bytes) ||
    limits.recordBytes < 1 ||
    limits.bytes < limits.recordBytes
  )
    throw new Error('Invalid range or batch limits')
  const records: Buffer[] = []
  let bytes: Buffer = Buffer.alloc(0),
    at = 0,
    readAt = offset,
    readSize = 64 * 1024
  while (records.length < limits.rows) {
    const newline = bytes.indexOf(10, at)
    if (newline < 0 && readAt < source.size) {
      if (bytes.length - at > limits.recordBytes) throw new Error('Record byte limit exceeded')
      if (records.length && bytes.length >= limits.bytes) break
      // Start small so 500 narrow rows do not repeatedly download megabytes of
      // overlapping lookahead. Grow only when this batch needs more bytes.
      const size = Math.min(
        readSize,
        source.size - readAt,
        at + limits.recordBytes + 1 - bytes.length
      )
      const chunk = await source.read(readAt, readAt + size)
      if (chunk.length !== size) throw new Error('Incomplete source range')
      bytes = Buffer.concat([bytes, chunk])
      readAt += size
      readSize = Math.min(readSize * 2, limits.bytes)
      continue
    }
    if (at === bytes.length) break
    const lineEnd = newline < 0 ? bytes.length : newline
    const next = newline < 0 ? lineEnd : lineEnd + 1
    if (lineEnd - at > limits.recordBytes) throw new Error('Record byte limit exceeded')
    if (records.length && next > limits.bytes) break
    records.push(Buffer.from(bytes.subarray(at, lineEnd)))
    at = next
    if (at >= limits.bytes) break
  }
  return {
    records,
    consumed: Buffer.from(bytes.subarray(0, at)),
    next: offset + at,
    done: offset + at === source.size,
  }
}
