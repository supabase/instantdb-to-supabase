-- Private job store: present, closed to the Data API roles, and guarded against future tables
-- that forget row level security.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(26);

SELECT has_schema('instant_import_service');
SELECT has_table('instant_import_service', t, format('instant_import_service.%s exists', t))
FROM unnest(ARRAY[
  'jobs', 'targets', 'files', 'rows', 'edges', 'unique_values', 'blobs', 'transfers',
  'artifacts', 'browser_jobs', 'oauth_states', 'oauth_connections',
  'oauth_database_credentials', 'platform_cooldowns'
]::name[]) AS t;
-- Columns added after the first runtime-initialized deployments; ensureStore checks telemetry_id.
SELECT has_column('instant_import_service', 'browser_jobs', 'telemetry_id', 'browser_jobs.telemetry_id exists');
SELECT has_column('instant_import_service', 'oauth_states', 'telemetry_id', 'oauth_states.telemetry_id exists');
SELECT has_column('instant_import_service', 'transfers', 'storage_version', 'transfers.storage_version exists');
SELECT has_index('instant_import_service', 'edges', 'edges_reverse', 'reverse edge index exists');
SELECT has_index('instant_import_service', 'unique_values', 'unique_lookup', 'unique value lookup index exists');

-- Generic over the catalog, so a table added by a later migration is covered automatically.
SELECT is(
  ARRAY(SELECT tablename FROM pg_tables WHERE schemaname = 'instant_import_service' AND NOT rowsecurity ORDER BY 1),
  '{}'::name[],
  'every instant_import_service table has row level security enabled'
);
SELECT is(
  ARRAY(SELECT format('%s.%s', tablename, policyname) FROM pg_policies WHERE schemaname = 'instant_import_service' ORDER BY 1),
  '{}'::text[],
  'instant_import_service has no policies'
);
SELECT is(
  ARRAY(
    SELECT format('%s:%s', r, privilege) FROM unnest(ARRAY['anon', 'authenticated', 'public']) AS r
    CROSS JOIN unnest(ARRAY['USAGE', 'CREATE']) AS privilege
    WHERE has_schema_privilege(r, 'instant_import_service', privilege) ORDER BY 1
  ),
  '{}'::text[],
  'client roles have no privileges on the instant_import_service schema'
);
SELECT is(
  ARRAY(
    SELECT format('%s:%s', r, c.relname) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN unnest(ARRAY['anon', 'authenticated']) AS r
    WHERE n.nspname = 'instant_import_service' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND has_table_privilege(r, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    ORDER BY 1
  ),
  '{}'::text[],
  'client roles have no privileges on any instant_import_service relation'
);

SET LOCAL ROLE anon;
SELECT throws_ok('SELECT 1 FROM instant_import_service.oauth_connections', '42501', NULL, 'anon cannot read OAuth connections');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT throws_ok('SELECT 1 FROM instant_import_service.jobs', '42501', NULL, 'authenticated cannot read jobs');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
