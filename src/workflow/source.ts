import { validatePath } from '../import/input'
import { PlatformRetryError, retryDeadline } from '../platform-retry'
import type { RangeSource } from './batches'
import type { SourceFile } from './store'

export type SourceConfig = { url: string; key: string; bucket: string }
export const sourceConfig = (): SourceConfig => {
  const url = process.env.IMPORT_JOB_SUPABASE_URL,
    key = process.env.IMPORT_JOB_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Configure service-owned Storage credentials')
  return { url, key, bucket: 'instant-import-inputs' }
}

/** Exact manifest keys only: never a bucket-wide or prefix deletion. Missing objects are safe. */
export async function removeSourceObjects(keys: string[], config = sourceConfig()) {
  if (!keys.length || keys.length > 100) throw new Error('Invalid cleanup batch size')
  for (const key of keys) validatePath(key)
  const response = await fetch(
    `${config.url}/storage/v1/object/${encodeURIComponent(config.bucket)}`,
    {
      method: 'DELETE',
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prefixes: keys }),
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    }
  )
  await response.body?.cancel()
  if (response.status === 429 || response.status >= 500)
    throw new PlatformRetryError(response.status, retryDeadline(response.headers, response.status))
  if (!response.ok) throw new Error('Backup deletion failed')
}
/** TUS rejects zero-byte uploads. Standard uploads preserve empty files without padding them. */
export async function ensureEmptySource(objectKey: string, config = sourceConfig()) {
  validatePath(objectKey)
  const path = `${encodeURIComponent(config.bucket)}/${objectKey.split('/').map(encodeURIComponent).join('/')}`
  const headers = { apikey: config.key, Authorization: `Bearer ${config.key}` }
  const readHead = () =>
    fetch(`${config.url}/storage/v1/object/authenticated/${path}`, {
      method: 'HEAD',
      headers,
      signal: AbortSignal.timeout(30_000),
    })
  let head = await readHead()
  if (!head.ok) {
    if (![400, 404].includes(head.status))
      throw new Error(`Source object lookup failed (${head.status})`)
    const response = await fetch(`${config.url}/storage/v1/object/${path}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/octet-stream', 'x-upsert': 'false' },
      body: new Uint8Array(0),
      signal: AbortSignal.timeout(30_000),
    })
    await response.body?.cancel()
    if (!response.ok) throw new Error(`Empty source upload failed (${response.status})`)
    head = await readHead()
  }
  const etag = head.headers.get('etag')
  if (!head.ok || head.headers.get('content-length') !== '0' || !etag)
    throw new Error('Empty source upload verification failed')
  return etag
}
export function storageSource(file: SourceFile, config = sourceConfig()): RangeSource {
  validatePath(file.object_key)
  const size = Number(file.size)
  return {
    size,
    async read(start, end) {
      if (end === start) return Buffer.alloc(0)
      const url = `${config.url}/storage/v1/object/authenticated/${config.bucket}/${file.object_key.split('/').map(encodeURIComponent).join('/')}`
      const response = await fetch(url, {
        headers: {
          apikey: config.key,
          Authorization: `Bearer ${config.key}`,
          Range: `bytes=${start}-${end - 1}`,
          ...(file.etag ? { 'If-Match': file.etag } : {}),
        },
        signal: AbortSignal.timeout(60_000),
      })
      if (
        response.status !== 206 ||
        response.headers.get('content-range') !== `bytes ${start}-${end - 1}/${size}`
      ) {
        await response.body?.cancel()
        throw new Error('Source range or immutable object version mismatch')
      }
      if (file.etag && response.headers.get('etag') !== file.etag) {
        await response.body?.cancel()
        throw new Error('Source object changed')
      }
      const chunks: Buffer[] = []
      let length = 0
      if (!response.body) throw new Error('Source body missing')
      for await (const chunk of response.body) {
        length += chunk.length
        if (length > end - start) {
          throw new Error('Source range exceeds requested length')
        }
        chunks.push(Buffer.from(chunk))
      }
      if (length !== end - start) throw new Error('Incomplete source range')
      return Buffer.concat(chunks, length)
    },
  }
}
