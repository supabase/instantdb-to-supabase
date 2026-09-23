import type { FileRecord, Link, Namespace, Plan } from './types'

const userFields = new Set(['email', 'type'])
const fileFields = new Set([
  'path',
  'url',
  'location-id',
  'size',
  'content-type',
  'content-disposition',
  'key-version',
])
export const hasAuthIdentity = (row: Namespace['rows'][number]) =>
  row.values.type !== 'guest' && typeof row.values.email === 'string'

export function storageMetadata(file: FileRecord) {
  const metadata: Record<string, string> = {}
  for (const [key, value] of [
    ['original_path', file.path],
    ['original_content_disposition', file.contentDisposition],
  ] as const) {
    if (value === undefined) continue
    if (value.includes('\0')) metadata[`${key}_base64`] = Buffer.from(value).toString('base64')
    else metadata[key] = value
  }
  return metadata
}

/** Source records remain in private provenance; only domain fields become public columns. */
export function nativeDestinations(
  namespaces: Namespace[],
  links: Omit<Link, 'mapping'>[],
  files: Plan['files'],
  diagnostics: Plan['diagnostics']
) {
  for (const ns of namespaces) {
    if (ns.source === '$users') {
      ns.columns = ns.columns.filter((c) => !userFields.has(c.source))
      ns.destination =
        ns.columns.length || ns.rows.some((r) => !hasAuthIdentity(r)) ? 'public' : 'auth'
      ns.target = ns.destination === 'public' ? 'user_accounts' : 'users'
    } else if (ns.source === '$files') {
      ns.columns = ns.columns.filter((c) => !fileFields.has(c.source))
      ns.destination = ns.columns.length ? 'public' : 'storage'
      ns.target = ns.destination === 'public' ? 'file_metadata' : 'objects'
    } else if (ns.source === '$streams' || ns.source === '$oauthProviders') {
      ns.destination = 'excluded'
      diagnostics.push({
        code: ns.source === '$streams' ? 'realtime_excluded' : 'oauth_setup',
        resource: ns.source,
        message:
          ns.source === '$streams'
            ? 'Realtime and streams are outside migration scope. Stream records and relationships are retained only as private source provenance.'
            : 'Configure sign-in providers in Supabase Auth. Source provider records are retained privately; provider credentials and identities are not inferred.',
      })
    } else if (ns.source.startsWith('$')) {
      throw new Error(
        'Unsupported system namespace. Add an explicit native mapping before importing it.'
      )
    }
  }
  const bySource = new Map(namespaces.map((ns) => [ns.source, ns]))
  const activeLinks = links.filter((link) => {
    const included =
      bySource.get(link.forward.on)!.destination !== 'excluded' &&
      bySource.get(link.reverse.on)!.destination !== 'excluded'
    if (!included)
      diagnostics.push({
        code: 'relationship_excluded',
        resource: link.source,
        message:
          'This relationship targets an excluded system namespace and is not created in the application schema.',
      })
    return included
  })
  // A file referenced by application data still migrates even if a stream also used it.
  const streamFiles = new Set<string>(),
    applicationFiles = new Set<string>()
  for (const link of links) {
    const side = link.forward.on === '$files' ? 0 : link.reverse.on === '$files' ? 1 : -1
    if (side === -1) continue
    const other = side === 0 ? link.reverse.on : link.forward.on
    const ids = other === '$streams' ? streamFiles : applicationFiles
    for (const edge of link.edges) ids.add(edge[side])
  }
  const activeFiles = files.filter((f) => !streamFiles.has(f.id) || applicationFiles.has(f.id))
  if (activeFiles.length !== files.length)
    diagnostics.push({
      code: 'stream_files_excluded',
      resource: '$files',
      message: `${files.length - activeFiles.length} files used only by excluded streams are not uploaded. Keep the original backup for their bytes.`,
    })
  return { links: activeLinks, files: activeFiles }
}

export const applicationNamespaces = (plan: Pick<Plan, 'namespaces'>) =>
  plan.namespaces.filter((ns) => ns.destination === 'public')
export function applicationRows(plan: Pick<Plan, 'files'>, ns: Namespace) {
  if (ns.source !== '$files') return ns.rows
  const included = new Set(plan.files.map((file) => file.id))
  return ns.rows.filter((row) => included.has(row.id))
}
