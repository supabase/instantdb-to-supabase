import type { Json } from './json'

export type ValueType = 'string' | 'number' | 'boolean' | 'date' | 'any'
export type Column = {
  source: string
  target: string
  type: ValueType
  storage: 'text' | 'double precision' | 'boolean' | 'timestamptz' | 'jsonb' | 'bytea'
  unique: boolean
  indexed: boolean
  required: boolean
  indexMethod: 'btree' | 'hash'
}
export type Row = {
  id: string
  createdAt: number
  raw: Buffer
  present: string[]
  values: Record<string, Json>
}
export type Namespace = {
  source: string
  target: string
  destination: 'public' | 'auth' | 'storage' | 'excluded'
  columns: Column[]
  rows: Row[]
}
export type LinkSide = {
  on: string
  label: string
  has: 'one' | 'many'
  required?: boolean
  onDelete?: 'cascade'
}
export type Link = {
  source: string
  target: string
  mapping:
    | {
        kind: 'foreign_key'
        table: string
        column: string
        referencedTable: string
        referencedSchema?: 'auth' | 'storage'
        owner: 'forward' | 'reverse'
        required: boolean
        unique: boolean
        onDelete: 'cascade' | 'set null' | 'no action'
      }
    | {
        kind: 'junction'
        table: string
        sourceColumn: string
        targetColumn: string
        sourceUnique?: boolean
        targetUnique?: boolean
      }
  forward: LinkSide
  reverse: LinkSide
  edges: [string, string][]
}
export type FileRecord = {
  id: string
  key: string
  path: string
  size: number
  contentType: string
  contentDisposition?: string
  hash: string
  bytes: Buffer
}
export type Diagnostic = { code: string; resource: string; message: string }
export type Plan = {
  version: 3
  contentHash: string
  config: Buffer
  namespaces: Namespace[]
  links: Link[]
  files: FileRecord[]
  diagnostics: Diagnostic[]
  sourceTotals: Plan['totals']
  totals: { namespaces: number; rows: number; edges: number; files: number; bytes: number }
}
