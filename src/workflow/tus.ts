/** A single 6 MiB TUS PATCH per worker step; upload URLs are stored only in the private ledger. */
export const uploadChunkBytes = 6 * 1024 * 1024
export async function createUpload(
  endpoint: string,
  key: string,
  bucket: string,
  name: string,
  size: number,
  metadata: Record<string, string> = {}
) {
  const base = new URL(endpoint)
  if (base.protocol === 'https:' && /^[a-z0-9]{20}\.supabase\.co$/.test(base.hostname))
    base.hostname = base.hostname.replace('.supabase.co', '.storage.supabase.co')
  endpoint = base.origin
  const values = {
    bucketName: bucket,
    objectName: name,
    contentType: metadata.contentType ?? 'application/octet-stream',
    cacheControl: '3600',
    ...metadata,
  }
  const response = await fetch(`${endpoint}/storage/v1/upload/resumable`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(size),
      'Upload-Metadata': Object.entries(values)
        .map(([k, v]) => `${k} ${Buffer.from(v).toString('base64')}`)
        .join(','),
      'x-upsert': 'false',
    },
    signal: AbortSignal.timeout(60_000),
  })
  // Neither creation nor a chunk has a body worth reading; release it before any throw
  // so a failed request cannot hold its socket open for the rest of the step.
  await response.body?.cancel()
  if (response.status !== 201)
    throw new Error(`Storage upload creation failed (${response.status})`)
  const location = response.headers.get('location')
  if (!location) throw new Error('Storage upload location missing')
  const url = new URL(location, endpoint)
  if (url.origin !== new URL(endpoint).origin) throw new Error('Unexpected upload origin')
  return url.toString()
}
export async function uploadOffset(url: string, key: string) {
  const response = await fetch(url, {
    method: 'HEAD',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Tus-Resumable': '1.0.0' },
    signal: AbortSignal.timeout(60_000),
  })
  if (response.status === 404 || response.status === 410) return null
  if (!response.ok) throw new Error(`Storage upload offset failed (${response.status})`)
  const value = Number(response.headers.get('upload-offset'))
  if (!response.headers.has('upload-offset') || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid upload offset')
  return value
}
export async function uploadChunk(url: string, key: string, offset: number, bytes: Buffer) {
  if (bytes.length > uploadChunkBytes) throw new Error('Upload chunk exceeds limit')
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Tus-Resumable': '1.0.0',
      'Upload-Offset': String(offset),
      'Content-Type': 'application/offset+octet-stream',
    },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(60_000),
  })
  await response.body?.cancel()
  if (
    response.status !== 204 ||
    Number(response.headers.get('upload-offset')) !== offset + bytes.length
  )
    throw new Error(`Storage upload chunk failed (${response.status})`)
}
