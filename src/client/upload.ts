import { createSHA256 } from 'hash-wasm'
import { Upload } from 'tus-js-client'

import type { FileDescriptor, ImportConnection } from './contracts'
import { requestJson, type RetryOptions } from './request'

export type SelectedFile = { path: string; file: File }
export function selectFiles(files: File[]): SelectedFile[] {
  if (!files.length || files.length > 10000)
    throw new Error('Choose a backup folder containing at most 10,000 files')
  const selected = files
    .map((file) => {
      const raw = file.webkitRelativePath || file.name
      return { file, path: file.webkitRelativePath ? raw.split('/').slice(1).join('/') : raw }
    })
    .filter(({ path }) => !path.startsWith('__MACOSX/') && !path.endsWith('.DS_Store'))
  const names = new Set<string>()
  for (const { path, file } of selected) {
    if (
      path.length > 1024 ||
      path.includes('\\') ||
      path.split('/').some((p) => p === '..' || p === '.' || !p) ||
      !(
        path === 'config.json' ||
        /^entities\/[^/]+\.jsonl$/.test(path) ||
        /^files\/[a-f0-9-]{36}$/i.test(path)
      )
    )
      throw new Error(
        `${path} does not belong in a backup. Choose an extracted folder with config.json, entities, and files.`
      )
    const key = path.normalize('NFC').toLowerCase()
    if (names.has(key)) throw new Error('The folder contains conflicting file names')
    names.add(key)
    if (path === 'config.json' && file.size > 8 * 1024 * 1024)
      throw new Error('config.json must be 8 MiB or smaller')
  }
  if (!names.has('config.json')) throw new Error('The backup folder is missing config.json')
  // Code-unit order: the server recomputes the selection hash with the same comparator.
  return selected.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
export async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
  options?: RetryOptions
): Promise<T> {
  return requestJson<T>(
    `/api/browser-imports${path}`,
    {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    },
    options
  )
}
async function sha256(file: Blob, signal: AbortSignal) {
  const hash = await createSHA256()
  for (let offset = 0; offset < file.size; offset += 6 * 1024 * 1024) {
    signal.throwIfAborted()
    hash.update(new Uint8Array(await file.slice(offset, offset + 6 * 1024 * 1024).arrayBuffer()))
  }
  return hash.digest('hex')
}
export async function uploadBackup(input: {
  files: SelectedFile[]
  target?: ImportConnection
  jobId?: string
  signal: AbortSignal
  onRetry?: (message: string) => void
  onJob: (id: string) => void
  onProgress: (value: { file: string; bytes: number; total: number; hashing: boolean }) => void
}) {
  const { files, signal } = input
  const options = { signal, onRetry: input.onRetry }
  const selection = files.map(({ path, file }) => [path, file.size])
  const selectionHash = await sha256(new Blob([JSON.stringify(selection)]), signal)
  let jobId = input.jobId
  if (!jobId) {
    jobId = (
      await api<{ jobId: string }>(
        '',
        {
          target: input.target,
          fileCount: files.length,
          selectionHash,
        },
        'POST',
        options
      )
    ).jobId
    input.onJob(jobId)
  }
  const total = files.reduce((sum, { file }) => sum + file.size, 0)
  let completed = 0
  for (const { path, file } of files) {
    signal.throwIfAborted()
    input.onProgress({ file: path, bytes: completed, total, hashing: true })
    const descriptor: FileDescriptor = { path, size: file.size, sha256: await sha256(file, signal) }
    const signed = await api<{
      id: string
      uploaded: boolean
      endpoint: string
      token?: string
      bucket: string
      objectKey: string
    }>(`/${jobId}/files`, descriptor, 'POST', options)
    if (!signed.uploaded) {
      await new Promise<void>((resolve, reject) => {
        const uploader = new Upload(file, {
          endpoint: signed.endpoint,
          headers: { 'x-signature': signed.token! },
          chunkSize: 6 * 1024 * 1024,
          retryDelays: [0, 1000, 3000, 5000],
          removeFingerprintOnSuccess: true,
          metadata: {
            bucketName: signed.bucket,
            objectName: signed.objectKey,
            contentType: 'application/octet-stream',
          },
          fingerprint: async () => `instant-import:${jobId}:${signed.id}:${descriptor.sha256}`,
          onProgress: (bytes) =>
            input.onProgress({ file: path, bytes: completed + bytes, total, hashing: false }),
          onError: () => {
            cleanup()
            reject(
              new Error('Upload paused. Check your connection, then resume with the same folder.')
            )
          },
          onSuccess: () => {
            cleanup()
            resolve()
          },
        })
        const abort = () => {
          void uploader.abort()
          cleanup()
          reject(new DOMException('Upload paused', 'AbortError'))
        }
        const cleanup = () => signal.removeEventListener('abort', abort)
        signal.addEventListener('abort', abort, { once: true })
        void uploader
          .findPreviousUploads()
          .then((previous) => {
            if (signal.aborted) {
              abort()
              return
            }
            if (previous[0]) uploader.resumeFromPreviousUpload(previous[0])
            uploader.start()
          })
          .catch(() => {
            cleanup()
            reject(new Error('Could not resume the upload. Try again.'))
          })
      })
    }
    await api(`/${jobId}/files/${signed.id}`, {}, 'POST', options)
    completed += file.size
    input.onProgress({ file: path, bytes: completed, total, hashing: false })
  }
  signal.throwIfAborted()
  await api(`/${jobId}/start`, { selectionHash }, 'POST', options)
  return jobId
}
