import pluralize from 'pluralize'

import { hash } from './input'
import { applicationNamespaces } from './native'
import type { Link, Namespace } from './types'

export function readableName(source: string): string {
  const value = source
    .normalize('NFKC')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
  return /^\d/.test(value) ? `field_${value}` : value || 'unnamed'
}
function shorten(value: string, bytes: number) {
  let result = ''
  for (const character of value) {
    if (Buffer.byteLength(result + character) > bytes) break
    result += character
  }
  return result
}
/** Suffixes appear only for real collisions or identifiers exceeding Postgres's limit. */
class Names {
  private used: Set<string>
  constructor(reserved: string[] = []) {
    this.used = new Set(reserved)
  }
  take(preferred: string, source: string): string {
    const name = readableName(preferred)
    if (Buffer.byteLength(name) <= 63 && !this.used.has(name)) {
      this.used.add(name)
      return name
    }
    for (let attempt = 0; ; attempt++) {
      const candidate = `${shorten(name, 50)}_${hash(`${source}:${attempt}`).slice(0, 12)}`
      if (!this.used.has(candidate)) {
        this.used.add(candidate)
        return candidate
      }
    }
  }
}
export function relationalModel(namespaces: Namespace[], links: Omit<Link, 'mapping'>[]): Link[] {
  const tables = new Names()
  const columns = new Map<string, Names>()
  for (const ns of [...namespaces].sort((a, b) => (a.source < b.source ? -1 : 1))) {
    if (ns.destination !== 'public') continue
    ns.target = tables.take(ns.target, ns.source)
    const names = new Names([
      'id',
      'ctid',
      'xmin',
      'xmax',
      'cmin',
      'cmax',
      'tableoid',
      ...(ns.source === '$users'
        ? ['auth_user_id']
        : ns.source === '$files'
          ? ['storage_object_id']
          : []),
    ])
    for (const column of [...ns.columns].sort((a, b) => (a.source < b.source ? -1 : 1)))
      column.target = names.take(column.source, column.source)
    columns.set(ns.source, names)
  }
  const bySource = new Map(namespaces.map((ns) => [ns.source, ns]))
  return links.map((link) => {
    const forward = bySource.get(link.forward.on)!,
      reverse = bySource.get(link.reverse.on)!
    const forwardOwns = forward.destination === 'public' && link.forward.has === 'one'
    const reverseOwns = reverse.destination === 'public' && link.reverse.has === 'one'
    if (!forwardOwns && !reverseOwns) {
      const table = tables.take(
        `${forward.destination === 'public' ? forward.target : readableName(forward.source)}_${readableName(link.forward.label)}`,
        link.source
      )
      const names = new Names()
      const sourceColumn = names.take(
        `${pluralize.singular(readableName(forward.source))}_id`,
        `${link.source}:source`
      )
      const targetColumn = names.take(
        `${pluralize.singular(readableName(link.forward.label))}_id`,
        `${link.source}:target`
      )
      return {
        ...link,
        target: table,
        mapping: {
          kind: 'junction',
          table,
          sourceColumn,
          targetColumn,
          ...(link.forward.has === 'one' ? { sourceUnique: true } : {}),
          ...(link.reverse.has === 'one' ? { targetUnique: true } : {}),
        },
      }
    }
    // A one-valued side stores the FK. For one-to-one, prefer its required side.
    const owner =
      forwardOwns && !(reverseOwns && link.reverse.required && !link.forward.required)
        ? 'forward'
        : 'reverse'
    const side = link[owner]
    const table = owner === 'forward' ? forward.target : reverse.target
    const referencedTable = owner === 'forward' ? reverse.target : forward.target
    const preferred = `${readableName(side.label).replace(/_id$/, '')}_id`
    const column = columns.get(side.on)!.take(preferred, link.source)
    return {
      ...link,
      target: table,
      mapping: {
        kind: 'foreign_key',
        table,
        column,
        referencedTable,
        ...((owner === 'forward' ? reverse : forward).destination === 'public'
          ? {}
          : {
              referencedSchema: (owner === 'forward' ? reverse : forward).destination as
                | 'auth'
                | 'storage',
            }),
        owner,
        required: !!side.required,
        unique: link.forward.has === 'one' && link.reverse.has === 'one',
        onDelete:
          side.onDelete === 'cascade' ? 'cascade' : side.required ? 'no action' : 'set null',
      },
    }
  })
}
export function publicTables(plan: { namespaces: Namespace[]; links: Link[] }) {
  return [
    ...applicationNamespaces(plan).map((n) => n.target),
    ...plan.links.flatMap((l) => (l.mapping.kind === 'junction' ? [l.mapping.table] : [])),
  ]
}
export const foreignKeysFor = (plan: { links: Link[] }, table: string) =>
  plan.links.flatMap((link) =>
    link.mapping.kind === 'foreign_key' && link.mapping.table === table
      ? [{ link, ...link.mapping }]
      : []
  )
