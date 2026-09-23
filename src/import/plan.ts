import { z } from 'zod'

import { hash, limits, validatePath } from './input'
import { byCodeUnit, canonical, parseJson, type Json } from './json'
import { nativeDestinations } from './native'
import { relationalModel } from './relational'
import type { Column, Link, Namespace, Plan, ValueType } from './types'

const name = z
  .string()
  .min(1)
  .max(1024)
  .refine((x) => !x.includes('\0'))
const attribute = z
  .object({
    valueType: z.enum(['string', 'number', 'boolean', 'date', 'any']),
    required: z.boolean().optional(),
    config: z
      .object({ unique: z.boolean().optional(), indexed: z.boolean().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough()
const side = z
  .object({
    on: name,
    label: name,
    has: z.enum(['one', 'many']),
    required: z.boolean().optional(),
    onDelete: z.literal('cascade').optional(),
  })
  .passthrough()
const configSchema = z
  .object({
    schema: z
      .object({
        entities: z.record(name, z.object({ attrs: z.record(name, attribute) }).passthrough()),
        links: z.record(name, z.object({ forward: side, reverse: side }).passthrough()),
      })
      .passthrough(),
    counts: z.record(name, z.number().int().nonnegative().safe()).optional(),
  })
  .passthrough()
const envelope = z
  .object({
    entity: z.record(z.unknown()).and(z.object({ id: z.string().uuid() })),
    createdAt: z.number().int().safe().nonnegative(),
  })
  .passthrough()
const uuid = z.string().uuid()
const systemFields: Record<string, Record<string, ValueType>> = {
  $users: { email: 'string', type: 'string' },
  $files: {
    'location-id': 'string',
    size: 'number',
    'content-type': 'string',
    'content-disposition': 'string',
    'key-version': 'number',
  },
  $streams: { hashedReconnectToken: 'string', machineId: 'string' },
  $oauthProviders: { name: 'string' },
}
const storage: Record<ValueType, Column['storage']> = {
  string: 'text',
  number: 'double precision',
  boolean: 'boolean',
  date: 'timestamptz',
  any: 'jsonb',
}

function normalize(value: Json, type: ValueType): Json {
  if (value === null || type === 'any') return value
  if (type === 'date') {
    if (
      typeof value !== 'number' &&
      (typeof value !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
    )
      throw new Error('Unsupported date representation')
    if (typeof value === 'number' && !Number.isSafeInteger(value))
      throw new Error('Invalid date milliseconds')
    const date = new Date(value)
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid date')
    if (typeof value === 'string') {
      // Date accepts 2024-02-30 and rolls it into March, so the calendar day is
      // checked directly. Date.UTC would remap years 0-99 into the 1900s.
      const [year, month, day] = value.slice(0, 10).split('-').map(Number)
      const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
      const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
      if (month < 1 || month > 12 || day < 1 || day > lengths[month - 1])
        throw new Error('Invalid calendar date')
    }
    return date.toISOString()
  }
  if (typeof value !== type) throw new Error('Attribute does not match its declared type')
  return value
}
const unsupportedText = (value: Json): boolean =>
  typeof value === 'string'
    ? value.includes('\0')
    : Array.isArray(value)
      ? value.some(unsupportedText)
      : value !== null && typeof value === 'object'
        ? Object.entries(value).some(([k, v]) => k.includes('\0') || unsupportedText(v))
        : false

export function analyze(entries: Map<string, Buffer>): Plan {
  return analyzeInput(entries, false)
}

export function analyzeMetadata(config: Buffer): Plan {
  return analyzeInput(new Map([['config.json', config]]), true)
}

/** Internal staging parser: global counts, graph integrity, uniqueness, and files must be validated by the durable staging ledger before target creation. */
export function analyzeRowBatch(config: Buffer, namespace: string, records: Buffer[]): Plan {
  return analyzeInput(
    new Map([
      ['config.json', config],
      [
        `entities/${namespace}.jsonl`,
        Buffer.concat(records.flatMap((r) => [r, Buffer.from('\n')])),
      ],
    ]),
    true
  )
}

function analyzeInput(entries: Map<string, Buffer>, staged: boolean): Plan {
  if (
    entries.size > limits.maxEntries ||
    [...entries.values()].reduce((n, b) => n + b.length, 0) > limits.maxExpandedBytes
  )
    throw new Error('Input limit exceeded')
  const configBytes = entries.get('config.json')
  if (!configBytes || configBytes.length > 8 * 1024 * 1024)
    throw new Error('Missing config.json or configuration limit exceeded')
  const parsed = configSchema.safeParse(parseJson(configBytes))
  if (!parsed.success)
    throw new Error(
      'Unsupported backup schema profile. Check config.json schema, links, and counts.'
    )
  const config = parsed.data
  const diagnostics: Plan['diagnostics'] = [
    {
      code: 'access_closed',
      resource: '*',
      message:
        'Tables start with RLS enabled and no client grants. Workflow imports apply supported direct policies; unresolved rules and Storage access require the setup prompts.',
    },
    {
      code: 'runtime_not_implemented',
      resource: '*',
      message:
        'Graph mutation APIs, inverse required-link mutation enforcement, unsupported permission rules, rate limits, and signup rules require manual setup. The importer does not recreate an application runtime.',
    },
    {
      code: 'configuration_setup',
      resource: '*',
      message:
        'Source configuration is preserved privately. Configure providers, email, redirects, and webhooks before application activation; credentials and live sessions are not imported.',
    },
  ]
  const knownConfig = new Set([
    'schema',
    'counts',
    'rules',
    'appId',
    'backupAt',
    'description',
    'title',
    'tripleCount',
    'isn',
    'webhooks',
    'emailTemplates',
    'authorizedRedirectOrigins',
  ])
  for (const key of Object.keys(config))
    if (!knownConfig.has(key))
      diagnostics.push({
        code: 'unknown_config',
        resource: key,
        message: 'Unknown configuration is retained privately and is not activated.',
      })
  const definitions = new Map(Object.entries(config.schema.entities))
  const entityFiles = new Map<string, Buffer>()
  const blobs = new Map<string, Buffer>()
  const pathKeys = new Set<string>()
  for (const [path, bytes] of entries) {
    validatePath(path)
    const key = path.normalize('NFC').toLowerCase()
    if (pathKeys.has(key)) throw new Error('Input path collision')
    pathKeys.add(key)
    if (bytes.length > limits.maxEntryBytes) throw new Error('Entry byte limit exceeded')
    if (path === 'config.json') continue
    if (path === '.DS_Store' || path.startsWith('__MACOSX/') || path.endsWith('/.DS_Store')) {
      diagnostics.push({
        code: 'packaging_ignored',
        resource: path,
        message: 'Ignored operating system packaging metadata.',
      })
      continue
    }
    const entityMatch = /^entities\/([^/]+)\.jsonl$/.exec(path)
    const fileMatch = /^files\/([^/]+)$/.exec(path)
    if (entityMatch) {
      const ns = entityMatch[1]
      if (!definitions.has(ns)) {
        if (ns !== '$oauthProviders') throw new Error('Unknown entity namespace')
        definitions.set(ns, { attrs: {} })
      }
      entityFiles.set(ns, bytes)
    } else if (fileMatch && uuid.safeParse(fileMatch[1]).success)
      blobs.set(fileMatch[1].toLowerCase(), bytes)
    else throw new Error('Unexpected archive entry')
  }
  if (definitions.size > 512 || Object.keys(config.schema.links).length > 2048)
    throw new Error('Schema complexity limit exceeded')
  for (const ns of definitions.keys())
    if (ns.startsWith('$') && !Object.hasOwn(systemFields, ns))
      throw new Error('Unsupported system namespace')
  const links: Omit<Link, 'mapping'>[] = Object.entries(config.schema.links)
    .sort(([a], [b]) => byCodeUnit(a, b))
    .map(([source, value]) => ({ source, target: source, ...value, edges: [] }))
  const labelRegistry = new Set<string>()
  for (const link of links)
    for (const s of [link.forward, link.reverse]) {
      if (!definitions.has(s.on)) throw new Error('Link references unknown namespace')
      const key = JSON.stringify([s.on, s.label])
      if (
        labelRegistry.has(key) ||
        Object.hasOwn(definitions.get(s.on)!.attrs, s.label) ||
        s.label === 'id'
      )
        throw new Error('Ambiguous link label')
      labelRegistry.add(key)
    }
  const forwardLinks = new Map(
    links.map((link) => [`${link.forward.on}\0${link.forward.label}`, link])
  )
  const reverseLabels = new Set(links.map((link) => `${link.reverse.on}\0${link.reverse.label}`))
  const namespaces: Namespace[] = []
  let rowCount = 0
  for (const [source, definition] of [...definitions].sort(([a], [b]) => byCodeUnit(a, b))) {
    if (Object.keys(definition.attrs).length > 512 || Object.hasOwn(definition.attrs, 'id'))
      throw new Error('Unsupported attribute schema')
    const columns = new Map<string, Column>()
    const addColumn = (
      field: string,
      type: ValueType,
      unique = false,
      indexed = false,
      required = false
    ) =>
      columns.set(field, {
        source: field,
        target: field,
        type,
        storage: storage[type],
        unique,
        indexed,
        required,
        indexMethod: 'btree',
      })
    for (const [field, d] of Object.entries(definition.attrs))
      addColumn(
        field,
        d.valueType,
        !!d.config?.unique,
        !!d.config?.indexed,
        !!d.required && !(source === '$files' && field === 'url')
      )
    const namespace: Namespace = {
      source,
      target: source,
      destination: 'public',
      columns: [],
      rows: [],
    }
    const ids = new Set<string>()
    const file = entityFiles.get(source)
    if (file) {
      let offset = 0
      while (offset < file.length) {
        const newline = file.indexOf(10, offset)
        const end = newline === -1 ? file.length : newline
        const raw = file.subarray(offset, end)
        offset = end + 1
        if (raw.length > 1024 * 1024) throw new Error('Record byte limit exceeded')
        if (raw.every((byte) => byte === 0x20 || byte === 0x09 || byte === 0x0d))
          throw new Error('Blank JSONL record. Remove empty lines from the entity file.')
        const rawRow = parseJson(raw)
        const parsedRow = envelope.safeParse(rawRow)
        if (!parsedRow.success) throw new Error('Invalid entity envelope')
        const { entity, createdAt } = rawRow as z.infer<typeof envelope>
        const id = entity.id.toLowerCase()
        if (ids.has(id)) throw new Error('Duplicate entity ID')
        ids.add(id)
        if (++rowCount > 100_000) throw new Error('Record count limit exceeded')
        const values: Record<string, Json> = Object.create(null)
        for (const [field, value] of Object.entries(entity)) {
          if (field === 'id') continue
          const link = forwardLinks.get(`${source}\0${field}`)
          if (link) {
            const targets =
              link.forward.has === 'many' ? z.array(uuid).parse(value) : [uuid.parse(value)]
            const normalized = targets.map((x) => x.toLowerCase())
            if (new Set(normalized).size !== normalized.length) throw new Error('Duplicate edge')
            for (const target of normalized) link.edges.push([id, target])
            continue
          }
          if (reverseLabels.has(`${source}\0${field}`))
            throw new Error('Unexpected reverse link data')
          if (!columns.has(field)) {
            // Undeclared attributes become columns too, and Postgres tables cap at 1600.
            if (columns.size >= 512) throw new Error('Unsupported attribute schema')
            const registry = Object.hasOwn(systemFields, source) ? systemFields[source] : undefined
            const builtin = registry && Object.hasOwn(registry, field) ? registry[field] : undefined
            addColumn(field, builtin ?? 'any')
            if (!builtin)
              diagnostics.push({
                code: 'unknown_attribute',
                resource: `${source}.${field}`,
                message:
                  'Preserved undeclared attribute as JSON; behavioral mapping requires review.',
              })
          }
          const column = columns.get(field)!
          values[field] = normalize(value as Json, column.type)
          if (unsupportedText(values[field])) column.storage = 'bytea'
        }
        for (const [field, d] of Object.entries(definition.attrs)) {
          if (
            d.required &&
            !(source === '$files' && field === 'url') &&
            (!Object.hasOwn(entity, field) || entity[field] === null)
          )
            throw new Error('Missing required attribute')
        }
        namespace.rows.push({ id, createdAt, raw, present: Object.keys(entity).sort(), values })
      }
    }
    if (
      !staged &&
      config.counts &&
      (Object.hasOwn(config.counts, source) ? config.counts[source] : 0) !== namespace.rows.length
    )
      throw new Error('Namespace count mismatch')
    namespace.columns = [...columns.values()].sort((a, b) => byCodeUnit(a.source, b.source))
    namespace.rows.sort((a, b) => byCodeUnit(a.id, b.id))
    for (const column of namespace.columns) {
      if (column.storage === 'bytea')
        diagnostics.push({
          code: 'encoded_attribute',
          resource: `${source}.${column.source}`,
          message:
            'Stored as UTF-8 JSON bytes to preserve values that Postgres text cannot represent.',
        })
      if (
        column.storage === 'jsonb' ||
        column.storage === 'bytea' ||
        (column.storage === 'text' &&
          namespace.rows.some(
            (row) =>
              typeof row.values[column.source] === 'string' &&
              Buffer.byteLength(row.values[column.source] as string) > 1024
          ))
      )
        column.indexMethod = 'hash'
      if (column.unique && column.indexMethod === 'hash')
        diagnostics.push({
          code: 'manual_unique_constraint',
          resource: `${source}.${column.source}`,
          message:
            'Source uniqueness was validated, but this value needs an application-specific Postgres constraint before writes are enabled. No custom trigger was generated.',
        })
      const seen = new Set<string>()
      for (const row of namespace.rows) {
        const value = row.values[column.source]
        if (value === undefined || value === null) continue
        const key = canonical(value)
        if (column.unique && seen.has(key)) throw new Error('Unique attribute conflict')
        seen.add(key)
      }
    }
    namespaces.push(namespace)
  }
  if (!staged && config.counts)
    for (const ns of Object.keys(config.counts))
      if (!definitions.has(ns)) throw new Error('Counts reference unknown namespace')
  const bySource = new Map(namespaces.map((ns) => [ns.source, ns]))
  if (!staged)
    for (const link of links) {
      for (const [s, index] of [
        [link.forward, 0],
        [link.reverse, 1],
      ] as const) {
        const ids = new Set(bySource.get(s.on)!.rows.map((x) => x.id))
        const counts = new Map<string, number>()
        for (const edge of link.edges) {
          const id = edge[index]
          if (!ids.has(id)) throw new Error('Missing link endpoint')
          counts.set(id, (counts.get(id) ?? 0) + 1)
        }
        if (s.has === 'one' && [...counts.values()].some((n) => n > 1))
          throw new Error('Link cardinality violation')
        if (s.required && [...ids].some((id) => !counts.has(id)))
          throw new Error('Missing required link')
      }
      link.edges.sort((a, b) => byCodeUnit(a.join(), b.join()))
    }
  const usedBlobs = new Set<string>()
  const files: Plan['files'] = []
  if (!staged)
    for (const row of bySource.get('$files')?.rows ?? []) {
      const v = row.values
      const location = uuid.parse(v['location-id']).toLowerCase()
      const bytes = blobs.get(location)
      if (!bytes) throw new Error('Missing file bytes')
      const path = z.string().parse(v.path)
      const size = z.number().int().nonnegative().safe().parse(v.size)
      const contentType =
        v['content-type'] === undefined
          ? 'application/octet-stream'
          : z
              .string()
              .regex(/^[\x20-\x7e]+$/)
              .parse(v['content-type'])
      if (size !== bytes.length) throw new Error('File size mismatch')
      usedBlobs.add(location)
      files.push({
        id: row.id,
        key: row.id,
        path,
        size,
        contentType,
        contentDisposition: z.string().optional().parse(v['content-disposition']),
        hash: hash(bytes),
        bytes,
      })
    }
  if (blobs.size !== usedBlobs.size) throw new Error('Unaccounted file bytes')
  const manifest = [...entries]
    .sort(([a], [b]) => byCodeUnit(a, b))
    .map(([path, bytes]) => [path, bytes.length, hash(bytes)])
  const sourceTotals = {
    namespaces: namespaces.length,
    rows: rowCount,
    edges: links.reduce((n, l) => n + l.edges.length, 0),
    files: files.length,
    bytes: files.reduce((n, f) => n + f.size, 0),
  }
  const native = nativeDestinations(namespaces, links, files, diagnostics)
  const model = relationalModel(
    namespaces,
    staged
      ? links.filter(
          (l) =>
            bySource.get(l.forward.on)!.destination !== 'excluded' &&
            bySource.get(l.reverse.on)!.destination !== 'excluded'
        )
      : native.links
  )
  // A source cascade only survives when the declaring side owns the generated FK.
  for (const link of model)
    for (const owner of ['forward', 'reverse'] as const)
      if (
        link[owner].onDelete === 'cascade' &&
        !(link.mapping.kind === 'foreign_key' && link.mapping.owner === owner)
      )
        diagnostics.push({
          code: 'cascade_not_representable',
          resource: link.source,
          message: `The source cascade on ${link[owner].on}.${link[owner].label} cannot be expressed by the generated ${link.mapping.kind === 'junction' ? 'junction table' : 'foreign key'}, so related rows are not deleted. Delete them in the application or add the cascade in a local migration.`,
        })
  return {
    version: 3,
    contentHash: hash(JSON.stringify(manifest)),
    config: configBytes,
    namespaces,
    links: model,
    files: native.files,
    diagnostics: [...new Map(diagnostics.map((d) => [JSON.stringify(d), d])).values()],
    sourceTotals,
    totals: {
      namespaces: namespaces.filter((ns) => ns.destination !== 'excluded').length,
      rows:
        namespaces
          .filter((ns) => ns.destination !== 'excluded' && ns.source !== '$files')
          .reduce((n, ns) => n + ns.rows.length, 0) + native.files.length,
      edges: native.links.reduce((n, l) => n + l.edges.length, 0),
      files: native.files.length,
      bytes: native.files.reduce((n, f) => n + f.size, 0),
    },
  }
}

export function sourceBatchEdges(config: Buffer, namespace: string, records: Buffer[]) {
  const definitions = configSchema.parse(parseJson(config)).schema.links
  return records.flatMap((raw) => {
    const { entity } = envelope.parse(parseJson(raw))
    return Object.entries(definitions).flatMap(([name, link]) => {
      if (link.forward.on !== namespace || !Object.hasOwn(entity, link.forward.label)) return []
      const value = entity[link.forward.label]
      const targets = link.forward.has === 'many' ? z.array(uuid).parse(value) : [uuid.parse(value)]
      return targets.map((target) => ({
        link: name,
        source: entity.id.toLowerCase(),
        target: target.toLowerCase(),
      }))
    })
  })
}
