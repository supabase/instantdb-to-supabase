import { joinSqlFragments, safeSql } from '@supabase/pg-meta'
import {
  getCreateMigrationsTableSQL,
  getInsertMigrationSQL,
} from '@supabase/pg-meta/src/sql/studio/database/migrations'
import type { Client } from 'pg'

import { buildApplicationSchema } from './sql'
import type { Plan } from './types'

export function nextMigrationVersion(existing: string[], now = new Date()): string {
  const used = new Set(existing)
  let date = now
  for (;;) {
    const version = date.toISOString().replace(/\D/g, '').slice(0, 14)
    if (!used.has(version)) return version
    date = new Date(date.getTime() + 1000)
  }
}

export function migrationFor(plan: Plan, version: string) {
  if (!/^\d{14}$/.test(version)) throw new Error('Invalid migration version')
  const name = `import_schema_${plan.contentHash.slice(0, 12)}`
  return {
    version,
    name,
    fileName: `${version}_${name}.sql`,
    statements: buildApplicationSchema(plan),
  }
}
export type SchemaMigration = ReturnType<typeof migrationFor>
export const migrationFile = (migration: SchemaMigration) =>
  safeSql`${joinSqlFragments(
    migration.statements.map((sql) => safeSql`${sql};`),
    '\n\n'
  )}\n`

/** Called inside the schema transaction. The table lock also excludes other history writers. */
export async function prepareMigrationHistory(db: Client) {
  await db.query(getCreateMigrationsTableSQL())
  // Older CLI history tables contained only the version column.
  await db.query(
    safeSql`ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements text[], ADD COLUMN IF NOT EXISTS name text`
  )
  await db.query(
    safeSql`LOCK TABLE supabase_migrations.schema_migrations IN SHARE ROW EXCLUSIVE MODE`
  )
  const existing = await db.query(
    safeSql`SELECT version FROM supabase_migrations.schema_migrations`
  )
  return nextMigrationVersion(existing.rows.map((row) => row.version))
}

export async function recordMigration(db: Client, migration: SchemaMigration) {
  await db.query(
    getInsertMigrationSQL({
      name: migration.name,
      version: migration.version,
      statements: JSON.stringify(migration.statements),
    })
  )
}

export async function verifyMigration(db: Client, migration: SchemaMigration) {
  const exists = await db.query(
    safeSql`SELECT to_regclass('supabase_migrations.schema_migrations') AS history`
  )
  if (!exists.rows[0].history)
    throw new Error('Migration history verification failed: history is missing')
  const result = await db.query(
    safeSql`SELECT name, statements FROM supabase_migrations.schema_migrations WHERE version = $1`,
    [migration.version]
  )
  if (
    result.rows.length !== 1 ||
    result.rows[0].name !== migration.name ||
    JSON.stringify(result.rows[0].statements) !== JSON.stringify(migration.statements)
  )
    throw new Error('Migration history verification failed: destination drift')
}
