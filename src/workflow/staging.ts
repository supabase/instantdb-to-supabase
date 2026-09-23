import { safeSql } from '@supabase/pg-meta'
import { createSHA256 } from 'hash-wasm'
import type { Client } from 'pg'
import { z } from 'zod'

import { hash } from '../import/input'
import { byCodeUnit, canonical, type Json } from '../import/json'
import { analyzeRowBatch, sourceBatchEdges } from '../import/plan'
import { relationalModel } from '../import/relational'
import type { Plan, Row } from '../import/types'
import { readRowBatch } from './batches'
import { storageSource } from './source'
import { advance, packPlan, unpackPlan, type Job, type SourceFile } from './store'

export function mergeModel(previous: Plan | null, batch: Plan): Plan {
  const result = previous ?? { ...batch, namespaces: [], files: [], links: [] }
  for (const ns of batch.namespaces) {
    let target = result.namespaces.find((n) => n.source === ns.source)
    if (!target) {
      target = { ...ns, rows: [] }
      result.namespaces.push(target)
    }
    if (ns.destination === 'public') {
      target.destination = ns.destination
      target.target = ns.target
    }
    for (const column of ns.columns) {
      const old = target.columns.find((c) => c.source === column.source)
      if (!old) target.columns.push({ ...column })
      else {
        if (column.storage === 'bytea') old.storage = 'bytea'
        if (column.indexMethod === 'hash') old.indexMethod = 'hash'
      }
    }
    if (target.columns.length > 512) throw new Error('Schema attribute limit exceeded')
    target.columns.sort((a, b) => byCodeUnit(a.source, b.source))
  }
  result.namespaces.sort((a, b) => byCodeUnit(a.source, b.source))
  // Reallocate names from source names; earlier batches may not yet have revealed
  // a native namespace's need for a public companion table.
  for (const ns of result.namespaces) if (!ns.source.startsWith('$')) ns.target = ns.source
  result.diagnostics = [
    ...new Map(
      [...result.diagnostics, ...batch.diagnostics].map((d) => [JSON.stringify(d), d])
    ).values(),
  ]
  result.links = relationalModel(
    result.namespaces,
    Object.entries(JSON.parse(result.config.toString()).schema.links).flatMap(
      ([source, definition]) => {
        const link = definition as Plan['links'][number]
        if (
          result.namespaces.find((n) => n.source === link.forward.on)?.destination === 'excluded' ||
          result.namespaces.find((n) => n.source === link.reverse.on)?.destination === 'excluded'
        )
          return []
        return [{ source, target: source, forward: link.forward, reverse: link.reverse, edges: [] }]
      }
    )
  )
  return result
}
export async function stageRecords(db: Client, job: Job, namespace: string, records: Buffer[]) {
  if (records.some((record) => record.length === 0)) throw new Error('Empty JSONL record')
  const batch = analyzeRowBatch(job.config, namespace, records)
  const ns = batch.namespaces.find((n) => n.source === namespace)!
  const model = mergeModel(job.model ? unpackPlan(job.model) : null, batch)
  const rows: unknown[][] = [],
    unique: unknown[][] = []
  const declared = JSON.parse(job.config.toString()).schema.entities[namespace]?.attrs ?? {}
  const uniqueFields = new Set([
    ...ns.columns.filter((c) => c.unique).map((c) => c.source),
    ...Object.keys(declared).filter((field) => declared[field].config?.unique),
  ])
  for (const row of ns.rows) {
    if (row.present.some((field) => field.includes('\0')))
      throw new Error('Unsupported NUL attribute name')
    rows.push([
      row.id,
      row.raw.toString('hex'),
      Buffer.from(canonical(row.values)).toString('hex'),
      row.createdAt,
      row.present,
    ])
    const values: (readonly [string, Json | undefined])[] = [...uniqueFields].map(
      (field) => [`attribute:${field}`, row.values[field]] as const
    )
    if (
      namespace === '$users' &&
      row.values.type !== 'guest' &&
      typeof row.values.email === 'string'
    ) {
      const email = row.values.email
      if (email.trim() !== email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        throw new Error('Unsupported Auth email')
      values.push(['auth:email', email.toLowerCase()])
    }
    for (const [field, value] of values) {
      if (value === undefined || value === null) continue
      const bytes = Buffer.from(canonical(value))
      unique.push([field, hash(bytes), bytes.toString('hex'), row.id])
    }
  }
  if (rows.length)
    await db.query(
      safeSql`INSERT INTO instant_import_service.rows(job_id,namespace,id,raw,normalized,created_at,presence) SELECT $1,$2,(r->>0)::uuid,decode(r->>1,'hex'),decode(r->>2,'hex'),(r->>3)::bigint,ARRAY(SELECT jsonb_array_elements_text(r->4)) FROM jsonb_array_elements($3::jsonb) r`,
      [job.id, namespace, JSON.stringify(rows)]
    )
  if (unique.length) {
    const data = JSON.stringify(unique)
    const conflict = await db.query(
      safeSql`WITH incoming AS (SELECT r->>0 AS field,r->>1 AS digest,decode(r->>2,'hex') AS value FROM jsonb_array_elements($3::jsonb) r) SELECT 1 FROM incoming i WHERE EXISTS(SELECT 1 FROM instant_import_service.unique_values v WHERE v.job_id=$1 AND v.namespace=$2 AND v.field=i.field AND v.digest=i.digest AND v.value=i.value) UNION ALL SELECT 1 FROM incoming GROUP BY field,digest,value HAVING count(*)>1 LIMIT 1`,
      [job.id, namespace, data]
    )
    if (conflict.rowCount) throw new Error('Unique attribute conflict across batches')
    await db.query(
      safeSql`INSERT INTO instant_import_service.unique_values(job_id,namespace,field,digest,value,entity_id) SELECT $1,$2,r->>0,r->>1,decode(r->>2,'hex'),(r->>3)::uuid FROM jsonb_array_elements($3::jsonb) r`,
      [job.id, namespace, data]
    )
  }
  const edges = sourceBatchEdges(job.config, namespace, records)
  for (let at = 0; at < edges.length; at += 1000)
    await db.query(
      safeSql`INSERT INTO instant_import_service.edges(job_id,link,source_id,target_id) SELECT $1,r->>'link',(r->>'source')::uuid,(r->>'target')::uuid FROM jsonb_array_elements($2::jsonb) r`,
      [job.id, JSON.stringify(edges.slice(at, at + 1000))]
    )
  await db.query(safeSql`UPDATE instant_import_service.jobs SET model=$2 WHERE id=$1`, [
    job.id,
    packPlan(model),
  ])
  return model
}
export type StagedRow = {
  id: string
  namespace: string
  raw: Buffer
  normalized: Buffer
  created_at: string
  presence: string[]
}
export const decodeRow = (row: StagedRow): Row => ({
  id: row.id,
  raw: row.raw,
  // Planning builds values without a prototype; a plain parse would let an absent attribute
  // named `toString` or `constructor` read an inherited function instead of undefined.
  values: Object.assign(Object.create(null), JSON.parse(row.normalized.toString())),
  createdAt: Number(row.created_at),
  present: row.presence,
})
/** SQL applies both limits before transferring records across the wire. */
export async function rowPage(db: Client, jobId: string, namespace: string, after: string) {
  const result = await db.query<StagedRow>(
    safeSql`WITH page AS (SELECT *,sum(octet_length(raw)+octet_length(normalized)) OVER (ORDER BY id) AS bytes,row_number() OVER (ORDER BY id) AS n FROM (SELECT * FROM instant_import_service.rows WHERE job_id=$1 AND namespace=$2 AND ($3::uuid IS NULL OR id>$3::uuid) ORDER BY id LIMIT 500) bounded) SELECT id,namespace,raw,normalized,created_at,presence FROM page WHERE bytes<=2097152 OR n=1 ORDER BY id`,
    [jobId, namespace, after || null]
  )
  return result.rows
}

export async function validatePage(db: Client, job: Job) {
  const plan = unpackPlan(job.model!),
    definitions = JSON.parse(job.config.toString()).schema.links as Record<
      string,
      Plan['links'][number]
    >
  const ns = plan.namespaces[job.cursor.index]
  if (!ns) {
    // All references were checked in bounded row pages. Aggregate counts never return source rows.
    const expectedNamespaces = Object.keys(JSON.parse(job.config.toString()).counts ?? {})
    if (expectedNamespaces.some((name) => !plan.namespaces.some((n) => n.source === name)))
      throw new Error('Counts reference unknown namespace')
    const count = async (sql: import('@supabase/pg-meta').SafeSqlFragment) =>
      Number((await db.query(sql, [job.id])).rows[0].n)
    const rows = await count(
      safeSql`SELECT count(*) AS n FROM instant_import_service.rows WHERE job_id=$1`
    )
    const edges = await count(
      safeSql`SELECT count(*) AS n FROM instant_import_service.edges WHERE job_id=$1`
    )
    const files = (
      await db.query(
        safeSql`SELECT count(*) AS n,coalesce(sum(size),0) AS bytes FROM instant_import_service.blobs WHERE job_id=$1`,
        [job.id]
      )
    ).rows[0]
    const manifest = (
      await db.query(
        safeSql`SELECT path,size,sha256 FROM instant_import_service.files WHERE job_id=$1 ORDER BY path COLLATE "C"`,
        [job.id]
      )
    ).rows
    // Manifest is capped at registration; row/blob contents are never included.
    manifest.sort((a, b) => byCodeUnit(a.path, b.path))
    plan.contentHash = hash(JSON.stringify(manifest.map((f) => [f.path, Number(f.size), f.sha256])))
    plan.sourceTotals = {
      namespaces: plan.namespaces.length,
      rows,
      edges,
      files: Number(files.n),
      bytes: Number(files.bytes),
    }
    const includedSources = plan.namespaces
      .filter((n) => n.destination !== 'excluded' && n.source !== '$files')
      .map((n) => n.source)
    const activeRows = (
      await db.query(
        safeSql`SELECT count(*) AS n FROM instant_import_service.rows WHERE job_id=$1 AND namespace=ANY($2)`,
        [job.id, includedSources]
      )
    ).rows[0]
    const activeEdges = (
      await db.query(
        safeSql`SELECT count(*) AS n FROM instant_import_service.edges WHERE job_id=$1 AND link=ANY($2)`,
        [job.id, plan.links.map((l) => l.source)]
      )
    ).rows[0]
    const activeFiles = (
      await db.query(
        safeSql`SELECT count(*) AS n,coalesce(sum(size),0) AS bytes FROM instant_import_service.blobs WHERE job_id=$1 AND included`,
        [job.id]
      )
    ).rows[0]
    const orphan = await db.query(
      safeSql`SELECT 1 FROM instant_import_service.files f WHERE job_id=$1 AND kind='blob' AND NOT EXISTS(SELECT 1 FROM instant_import_service.blobs b WHERE b.job_id=f.job_id AND b.source_file=f.id) LIMIT 1`,
      [job.id]
    )
    if (orphan.rowCount) throw new Error('Unaccounted file bytes')
    plan.totals = {
      namespaces: plan.namespaces.filter((n) => n.destination !== 'excluded').length,
      rows: Number(activeRows.n) + Number(activeFiles.n),
      edges: Number(activeEdges.n),
      files: Number(activeFiles.n),
      bytes: Number(activeFiles.bytes),
    }
    await db.query(safeSql`UPDATE instant_import_service.jobs SET model=$2 WHERE id=$1`, [
      job.id,
      packPlan(plan),
    ])
    await advance(db, job, 'schema')
    return
  }
  const page = await rowPage(db, job.id, ns.source, job.cursor.after)
  if (!page.length) {
    const expected = JSON.parse(job.config.toString()).counts
    const actual = Number(
      (
        await db.query(
          safeSql`SELECT count(*) AS n FROM instant_import_service.rows WHERE job_id=$1 AND namespace=$2`,
          [job.id, ns.source]
        )
      ).rows[0].n
    )
    if (expected && actual !== (expected[ns.source] ?? 0))
      throw new Error('Namespace count mismatch')
    await advance(db, job, 'validating', { index: job.cursor.index + 1, after: '', offset: 0 })
    return
  }
  const ids = page.map((r) => r.id)
  for (const [name, link] of Object.entries(definitions))
    for (const direction of ['forward', 'reverse'] as const) {
      if (link[direction].on !== ns.source) continue
      const query =
        direction === 'forward'
          ? safeSql`SELECT e.source_id AS id,e.target_id AS other FROM instant_import_service.edges e WHERE e.job_id=$1 AND e.link=$2 AND e.source_id=ANY($3::uuid[])`
          : safeSql`SELECT e.target_id AS id,e.source_id AS other FROM instant_import_service.edges e WHERE e.job_id=$1 AND e.link=$2 AND e.target_id=ANY($3::uuid[])`
      // Use SQL aggregation and anti-joins rather than materializing a high-fanout neighborhood.
      const result = await db.query(
        safeSql`WITH edges AS (${query}), counts AS (SELECT id,count(*) AS n FROM edges GROUP BY id) SELECT EXISTS(SELECT 1 FROM edges e WHERE NOT EXISTS(SELECT 1 FROM instant_import_service.rows r WHERE r.job_id=$1 AND r.namespace=$4 AND r.id=e.other)) AS missing, EXISTS(SELECT 1 FROM counts WHERE n>1) AS multiple, EXISTS(SELECT 1 FROM unnest($3::uuid[]) AS requested(id) WHERE NOT EXISTS(SELECT 1 FROM counts c WHERE c.id=requested.id)) AS absent`,
        [job.id, name, ids, link[direction === 'forward' ? 'reverse' : 'forward'].on]
      )
      const r = result.rows[0]
      if (
        r.missing ||
        (link[direction].has === 'one' && r.multiple) ||
        (link[direction].required && r.absent)
      )
        throw new Error('Link endpoint, cardinality, or required relationship violation')
    }
  if (ns.source === '$files')
    for (const staged of page) {
      const row = decodeRow(staged),
        v = row.values
      const location = z.string().uuid().parse(v['location-id']).toLowerCase()
      const f = (
        await db.query<SourceFile>(
          safeSql`SELECT * FROM instant_import_service.files WHERE job_id=$1 AND path_key=$2 AND kind='blob'`,
          [job.id, `files/${location}`]
        )
      ).rows[0]
      if (!f) throw new Error('Missing file bytes')
      const size = z.number().int().nonnegative().safe().parse(v.size)
      if (size !== Number(f.size)) throw new Error('File size mismatch')
      const metadata = {
        id: row.id,
        key: row.id,
        path: z.string().parse(v.path),
        size,
        contentType:
          v['content-type'] === undefined
            ? 'application/octet-stream'
            : z
                .string()
                .regex(/^[\x20-\x7e]+$/)
                .parse(v['content-type']),
        contentDisposition: z.string().optional().parse(v['content-disposition']),
        hash: f.sha256,
      }
      let stream = false,
        app = false
      for (const [name, l] of Object.entries(definitions)) {
        const side =
          l.forward.on === '$files' ? 'forward' : l.reverse.on === '$files' ? 'reverse' : null
        if (!side) continue
        const found = await db.query(
          side === 'forward'
            ? safeSql`SELECT 1 FROM instant_import_service.edges WHERE job_id=$1 AND link=$2 AND source_id=$3 LIMIT 1`
            : safeSql`SELECT 1 FROM instant_import_service.edges WHERE job_id=$1 AND link=$2 AND target_id=$3 LIMIT 1`,
          [job.id, name, row.id]
        )
        if (found.rowCount) {
          if (l[side === 'forward' ? 'reverse' : 'forward'].on === '$streams') stream = true
          else app = true
        }
      }
      await db.query(
        safeSql`INSERT INTO instant_import_service.blobs(job_id,id,source_file,metadata,included,size) VALUES($1,$2,$3,$4,$5,$6)`,
        [job.id, row.id, f.id, Buffer.from(JSON.stringify(metadata)), !stream || app, size]
      )
    }
  await advance(db, job, 'validating', { ...job.cursor, after: page.at(-1)!.id })
}

export async function analyzePage(db: Client, job: Job) {
  const file = (
    await db.query<SourceFile>(
      safeSql`SELECT * FROM instant_import_service.files WHERE job_id=$1 AND NOT verified ORDER BY path COLLATE "C" LIMIT 1`,
      [job.id]
    )
  ).rows[0]
  if (!file) {
    await advance(db, job, 'validating')
    return
  }
  const source = storageSource(file),
    offset = Number(file.byte_offset)
  const digest = await createSHA256()
  if (file.hash_state) digest.load(file.hash_state)
  let next: number, consumed: Buffer
  if (file.kind === 'entity') {
    const batch = await readRowBatch(source, offset)
    await stageRecords(db, job, file.namespace!, batch.records)
    next = batch.next
    consumed = batch.consumed
  } else {
    next = Math.min(source.size, offset + 6 * 1024 * 1024)
    consumed = await source.read(offset, next)
  }
  digest.update(consumed)
  const state = Buffer.from(digest.save()),
    done = next === source.size
  if (done && digest.digest('hex') !== file.sha256) throw new Error('Source SHA-256 mismatch')
  await db.query(
    safeSql`UPDATE instant_import_service.files SET byte_offset=$3,hash_state=$4,verified=$5 WHERE job_id=$1 AND id=$2`,
    [job.id, file.id, next, state, done]
  )
  await advance(db, job, 'analyzing')
}
