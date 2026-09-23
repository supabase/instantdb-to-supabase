import { safeSql } from '@supabase/pg-meta'
import type { Client } from 'pg'

import { prepareMigrationHistory, recordMigration, verifyMigration } from '../import/migrations'
import { compilePermissions } from '../import/permissions'
import type { Plan } from '../import/types'

/** The caller commits policies, migration history, and its batch receipt in one transaction. */
export async function applyPermissionMigration(db: Client, plan: Plan) {
  const version = await prepareMigrationHistory(db)
  const migration = {
    version,
    name: `import_permissions_${plan.contentHash.slice(0, 12)}`,
    fileName: '',
    statements: compilePermissions(plan).statements,
  }
  for (const statement of migration.statements) await db.query(statement)
  await recordMigration(db, migration)
}

export async function verifiedPermissionMigration(db: Client, plan: Plan) {
  const name = `import_permissions_${plan.contentHash.slice(0, 12)}`
  const versions = (
    await db.query(
      safeSql`SELECT version FROM supabase_migrations.schema_migrations WHERE name=$1`,
      [name]
    )
  ).rows
  if (versions.length !== 1) throw new Error('Permission migration history drift')
  const version = versions[0].version
  const migration = {
    name,
    version,
    fileName: `${version}_${name}.sql`,
    statements: compilePermissions(plan).statements,
  }
  await verifyMigration(db, migration)
  return migration
}
