import { ident, safeSql, type SafeSqlFragment } from '@supabase/pg-meta'

import { buildApplicationSchema, buildImportStateSchema, qualified } from '../import/sql'
import type { Plan } from '../import/types'

/** FK validation is a separate phase so cycles can span committed row batches. */
export function initialSchema(plan: Plan, schema: string) {
  return [
    ...buildImportStateSchema(schema),
    safeSql`CREATE TABLE ${qualified(schema, 'workflow_batches')} (step bigint PRIMARY KEY, checksum text NOT NULL)`,
    safeSql`ALTER TABLE ${qualified(schema, 'workflow_batches')} ENABLE ROW LEVEL SECURITY`,
    safeSql`REVOKE ALL ON TABLE ${qualified(schema, 'workflow_batches')} FROM PUBLIC,anon,authenticated`,
    ...initialApplicationSchema(plan),
  ]
}
export function initialApplicationSchema(plan: Plan) {
  const statements = buildApplicationSchema({ ...plan, links: [] })
  for (const { mapping: m } of plan.links) {
    if (m.kind === 'foreign_key')
      statements.push(
        safeSql`ALTER TABLE public.${ident(m.table)} ADD COLUMN ${ident(m.column)} uuid`
      )
    else
      statements.push(
        safeSql`CREATE TABLE public.${ident(m.table)} (${ident(m.sourceColumn)} uuid NOT NULL,${ident(m.targetColumn)} uuid NOT NULL,PRIMARY KEY(${ident(m.sourceColumn)},${ident(m.targetColumn)}))`,
        safeSql`ALTER TABLE public.${ident(m.table)} ENABLE ROW LEVEL SECURITY`,
        safeSql`REVOKE ALL ON TABLE public.${ident(m.table)} FROM PUBLIC,anon,authenticated`
      )
  }
  return statements
}
export function finalConstraints(plan: Plan): SafeSqlFragment[] {
  const statements: SafeSqlFragment[] = []
  for (const link of plan.links) {
    const m = link.mapping,
      t = qualified('public', m.table)
    if (m.kind === 'foreign_key') {
      const c = ident(m.column)
      if (m.required) statements.push(safeSql`ALTER TABLE ${t} ALTER COLUMN ${c} SET NOT NULL`)
      const action =
        m.onDelete === 'cascade'
          ? safeSql`CASCADE`
          : m.onDelete === 'set null'
            ? safeSql`SET NULL`
            : safeSql`NO ACTION`
      statements.push(
        safeSql`ALTER TABLE ${t} ADD FOREIGN KEY (${c}) REFERENCES ${qualified(m.referencedSchema ?? 'public', m.referencedTable)}(id) ON DELETE ${action} DEFERRABLE INITIALLY DEFERRED`
      )
      statements.push(
        m.unique
          ? safeSql`ALTER TABLE ${t} ADD UNIQUE (${c}) DEFERRABLE INITIALLY DEFERRED`
          : safeSql`CREATE INDEX ON ${t} (${c})`
      )
    } else {
      for (const [side, column] of [
        [link.forward, m.sourceColumn],
        [link.reverse, m.targetColumn],
      ] as const) {
        const ns = plan.namespaces.find((n) => n.source === side.on)!
        statements.push(
          safeSql`ALTER TABLE ${t} ADD FOREIGN KEY (${ident(column)}) REFERENCES ${qualified(ns.destination, ns.target)}(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED`
        )
      }
      statements.push(safeSql`CREATE INDEX ON ${t} (${ident(m.targetColumn)})`)
      if (m.sourceUnique)
        statements.push(
          safeSql`ALTER TABLE ${t} ADD UNIQUE (${ident(m.sourceColumn)}) DEFERRABLE INITIALLY DEFERRED`
        )
      if (m.targetUnique)
        statements.push(
          safeSql`ALTER TABLE ${t} ADD UNIQUE (${ident(m.targetColumn)}) DEFERRABLE INITIALLY DEFERRED`
        )
    }
  }
  return statements
}
