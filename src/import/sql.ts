import { ident, joinSqlFragments, safeSql, type SafeSqlFragment } from '@supabase/pg-meta'

import { applicationNamespaces } from './native'
import { foreignKeysFor, publicTables } from './relational'
import type { Column, Plan } from './types'

const types: Record<Column['storage'], SafeSqlFragment> = {
  text: safeSql`text COLLATE "C"`,
  'double precision': safeSql`double precision`,
  boolean: safeSql`boolean`,
  timestamptz: safeSql`timestamptz`,
  jsonb: safeSql`jsonb`,
  bytea: safeSql`bytea`,
}
const deleteActions = {
  cascade: safeSql`CASCADE`,
  'set null': safeSql`SET NULL`,
  'no action': safeSql`NO ACTION`,
}
export const qualified = (schema: string, table: string) =>
  safeSql`${ident(schema)}.${ident(table)}`

export function removeImportState(schema: string, workflow = false) {
  return [
    ...[
      ...(workflow ? ['workflow_batches'] : []),
      'provenance',
      'auth_map',
      'file_registry',
      'restore_job',
    ].map((table) => safeSql`DROP TABLE ${qualified(schema, table)} RESTRICT`),
    safeSql`DROP SCHEMA ${ident(schema)} RESTRICT`,
  ]
}

/** Temporary state used only while restoring and verifying the snapshot. */
export function buildImportStateSchema(schema: string): SafeSqlFragment[] {
  const s = ident(schema)
  const statements: SafeSqlFragment[] = [
    safeSql`CREATE SCHEMA ${s}`,
    safeSql`REVOKE ALL ON SCHEMA ${s} FROM PUBLIC, anon, authenticated`,
    safeSql`CREATE TABLE ${s}.restore_job (id boolean PRIMARY KEY DEFAULT true CHECK (id), content_hash text NOT NULL, version integer NOT NULL, schema_hash text NOT NULL DEFAULT '', owner uuid NOT NULL, state text NOT NULL, revision bigint NOT NULL DEFAULT 0, config bytea NOT NULL, bucket text NOT NULL, bucket_started boolean NOT NULL DEFAULT false, bucket_ready boolean NOT NULL DEFAULT false, data_loaded boolean NOT NULL DEFAULT false, migration_version text NOT NULL)`,
    safeSql`CREATE TABLE ${s}.provenance (table_name text NOT NULL, id uuid NOT NULL, source_created_at bigint NOT NULL, source_record bytea NOT NULL, source_presence text[] NOT NULL, PRIMARY KEY (table_name, id))`,
    safeSql`CREATE TABLE ${s}.auth_map (source_id uuid PRIMARY KEY, state text NOT NULL, email text, auth_id uuid)`,
    safeSql`CREATE TABLE ${s}.file_registry (source_id uuid PRIMARY KEY, object_key text NOT NULL, logical_path bytea NOT NULL, size bigint NOT NULL, sha256 text NOT NULL, content_type text NOT NULL, verified boolean NOT NULL DEFAULT false, storage_id uuid)`,
  ]
  for (const table of ['restore_job', 'provenance', 'auth_map', 'file_registry'])
    statements.push(safeSql`ALTER TABLE ${qualified(schema, table)} ENABLE ROW LEVEL SECURITY`)
  statements.push(safeSql`REVOKE ALL ON ALL TABLES IN SCHEMA ${s} FROM PUBLIC, anon, authenticated`)
  return statements
}

export function buildSchema(plan: Plan, schema: string): SafeSqlFragment[] {
  return [...buildImportStateSchema(schema), ...buildApplicationSchema(plan)]
}

/** Only application objects belong in the customer's migrations. */
export function buildApplicationSchema(plan: Plan): SafeSqlFragment[] {
  const statements: SafeSqlFragment[] = []
  for (const ns of applicationNamespaces(plan)) {
    const table = qualified('public', ns.target)
    const columns = [
      safeSql`id uuid PRIMARY KEY DEFAULT gen_random_uuid()`,
      ...(ns.source === '$users'
        ? [
            safeSql`auth_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED UNIQUE`,
          ]
        : ns.source === '$files'
          ? [
              safeSql`storage_object_id uuid NOT NULL REFERENCES storage.objects(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED UNIQUE`,
            ]
          : []),
      ...ns.columns.map(
        (c) =>
          safeSql`${ident(c.target)} ${types[c.storage]} ${c.required ? safeSql`NOT NULL` : safeSql``} ${c.unique && c.indexMethod === 'btree' ? safeSql`UNIQUE` : safeSql``}`
      ),
      ...foreignKeysFor(plan, ns.target).map(
        (fk) => safeSql`${ident(fk.column)} uuid ${fk.required ? safeSql`NOT NULL` : safeSql``}`
      ),
    ]
    statements.push(safeSql`CREATE TABLE ${table} (${joinSqlFragments(columns, ', ')})`)
    for (const c of ns.columns) {
      if ((c.indexed || c.unique) && !(c.unique && c.indexMethod === 'btree'))
        statements.push(
          safeSql`CREATE INDEX ON ${table} USING ${c.indexMethod === 'btree' ? safeSql`btree` : safeSql`hash`} (${ident(c.target)})`
        )
    }
  }
  const bySource = new Map(
    plan.namespaces.map((ns) => [ns.source, qualified(ns.destination, ns.target)])
  )
  // Add constraints after every table exists. Data can then load in arbitrary order,
  // including cycles, with FK and one-to-one checks deferred until the final commit.
  for (const link of plan.links) {
    const m = link.mapping
    const table = qualified('public', m.table)
    if (m.kind === 'foreign_key') {
      const col = ident(m.column)
      statements.push(
        safeSql`ALTER TABLE ${table} ADD FOREIGN KEY (${col}) REFERENCES ${qualified(m.referencedSchema ?? 'public', m.referencedTable)}(id) ON DELETE ${deleteActions[m.onDelete]} DEFERRABLE INITIALLY DEFERRED`
      )
      if (m.unique)
        statements.push(
          safeSql`ALTER TABLE ${table} ADD UNIQUE (${col}) DEFERRABLE INITIALLY DEFERRED`
        )
      else statements.push(safeSql`CREATE INDEX ON ${table} (${col})`)
    } else {
      const from = ident(m.sourceColumn),
        to = ident(m.targetColumn)
      statements.push(
        safeSql`CREATE TABLE ${table} (${from} uuid NOT NULL, ${to} uuid NOT NULL, PRIMARY KEY (${from}, ${to}), FOREIGN KEY (${from}) REFERENCES ${bySource.get(link.forward.on)!}(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY (${to}) REFERENCES ${bySource.get(link.reverse.on)!}(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED)`,
        safeSql`CREATE INDEX ON ${table} (${to})`
      )
      if (m.sourceUnique)
        statements.push(
          safeSql`ALTER TABLE ${table} ADD UNIQUE (${from}) DEFERRABLE INITIALLY DEFERRED`
        )
      if (m.targetUnique)
        statements.push(
          safeSql`ALTER TABLE ${table} ADD UNIQUE (${to}) DEFERRABLE INITIALLY DEFERRED`
        )
    }
  }
  for (const table of publicTables(plan)) {
    statements.push(
      safeSql`ALTER TABLE ${qualified('public', table)} ENABLE ROW LEVEL SECURITY`,
      safeSql`REVOKE ALL ON TABLE ${qualified('public', table)} FROM PUBLIC, anon, authenticated`
    )
  }
  return statements
}
