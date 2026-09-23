import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { readBackupFolder } from '../src/import/input'
import { migrationFile, migrationFor } from '../src/import/migrations'
import { compilePermissions, permissionsManual, permissionsSql } from '../src/import/permissions'
import { analyze } from '../src/import/plan'
import { restore } from '../src/import/restore'
import { buildApplicationSchema } from '../src/import/sql'

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      apply: { type: 'boolean', default: false },
      output: { type: 'string', default: 'artifacts' },
    },
    strict: true,
  })
  if (!values.input)
    throw new Error(
      'Pass --input /path/to/extracted-backup. Add --apply to restore into the configured blank project.'
    )
  const plan = analyze(await readBackupFolder(resolve(values.input)))
  const permissions = compilePermissions(plan)
  const directory = resolve(values.output, plan.contentHash)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const manifest = {
    version: plan.version,
    contentHash: plan.contentHash,
    schema: 'public',
    sourceTotals: plan.sourceTotals,
    totals: plan.totals,
    namespaces: plan.namespaces.map(({ source, target, destination, columns, rows }) => ({
      source,
      target,
      destination,
      columns,
      sourceCount: rows.length,
      importedCount:
        destination === 'excluded' ? 0 : source === '$files' ? plan.files.length : rows.length,
    })),
    links: plan.links.map(({ edges, ...link }) => ({ ...link, count: edges.length })),
    setup: plan.diagnostics,
    permissions: {
      ...permissions.summary,
      applied: false,
      report: 'permissions.json',
      manualReport: 'permissions-manual.md',
      sql: 'permissions.sql',
    },
  }
  await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), {
    mode: 0o600,
  })
  await writeFile(
    resolve(directory, 'schema.sql'),
    ['BEGIN;', ...buildApplicationSchema(plan).map((sql) => `${sql};`), 'COMMIT;'].join('\n\n'),
    { mode: 0o600 }
  )
  const permissionReport = { ...permissions, statements: undefined }
  await writeFile(
    resolve(directory, 'permissions.json'),
    JSON.stringify(permissionReport, null, 2),
    { mode: 0o600 }
  )
  await writeFile(resolve(directory, 'permissions-manual.md'), permissionsManual(permissions), {
    mode: 0o600,
  })
  await writeFile(resolve(directory, 'permissions.sql'), permissionsSql(permissions), {
    mode: 0o600,
  })
  if (!values.apply) {
    process.stdout.write(
      JSON.stringify({ state: 'analyzed', ...manifest, artifacts: directory }, null, 2) + '\n'
    )
    return
  }
  const databaseUrl = process.env.IMPORT_DATABASE_URL
  const supabaseUrl = process.env.IMPORT_SUPABASE_URL
  const serviceRoleKey = process.env.IMPORT_SERVICE_ROLE_KEY
  if (!databaseUrl || !supabaseUrl || !serviceRoleKey)
    throw new Error(
      'Set IMPORT_DATABASE_URL, IMPORT_SUPABASE_URL, and IMPORT_SERVICE_ROLE_KEY for the same blank project.'
    )
  const report = {
    ...(await restore(plan, { databaseUrl, supabaseUrl, serviceRoleKey })),
    permissions: manifest.permissions,
  }
  const migration = migrationFor(plan, report.migration.version)
  await mkdir(resolve(directory, 'migrations'), { recursive: true, mode: 0o700 })
  await writeFile(resolve(directory, 'migrations', migration.fileName), migrationFile(migration), {
    mode: 0o600,
  })
  await writeFile(resolve(directory, 'verification.json'), JSON.stringify(report, null, 2), {
    mode: 0o600,
  })
  process.stdout.write(JSON.stringify({ ...report, artifacts: directory }, null, 2) + '\n')
}
main().catch((error) => {
  // Do not print driver errors, source rows, or credentials. A job may have
  // committed before a failed response; rerunning reconciles its private state.
  process.stderr.write(
    'Import stopped. Partial resources may remain. Check the input and destination before resuming.\n'
  )
  if (error instanceof Error && !('code' in error) && !('details' in error))
    process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
