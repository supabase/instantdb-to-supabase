-- Insert-only usage log in public: reachable by the server connection only.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(18);

SELECT has_table('public', 'usage_events', 'public.usage_events exists');
SELECT columns_are('public', 'usage_events',
  ARRAY['id', 'occurred_at', 'event', 'job_id', 'target_ref', 'environment', 'properties']::name[]);
-- recordUsage relies on ON CONFLICT (id) DO NOTHING for retry-safe inserts.
SELECT col_is_pk('public', 'usage_events', 'id', 'id is the primary key');
SELECT col_not_null('public', 'usage_events', c, format('%s is not null', c))
FROM unnest(ARRAY['occurred_at', 'event', 'environment', 'properties']::name[]) AS c;
SELECT has_index('public', 'usage_events', 'usage_events_event', 'event/time index exists');
SELECT is(
  (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.usage_events'::regclass AND contype = 'f'),
  0::bigint,
  'no foreign keys, so rows outlive job cleanup'
);

-- Generic over public, so any later tracking table gets the same guarantees.
SELECT is(
  ARRAY(SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity ORDER BY 1),
  '{}'::name[],
  'every public table has row level security enabled'
);
SELECT is(
  ARRAY(SELECT format('%s.%s', tablename, policyname) FROM pg_policies WHERE schemaname = 'public' ORDER BY 1),
  '{}'::text[],
  'public has no policies'
);
SELECT is(
  ARRAY(
    SELECT format('%s:%s', r, c.relname) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN unnest(ARRAY['anon', 'authenticated']) AS r
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND has_table_privilege(r, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    ORDER BY 1
  ),
  '{}'::text[],
  'client roles have no privileges on any public relation'
);

-- The server connection writes idempotently.
SELECT lives_ok(
  $$INSERT INTO public.usage_events (id, event, environment) VALUES ('00000000-0000-4000-8000-000000000001', 'instant_import_job_created', 'development')$$,
  'the service connection can insert'
);
SELECT lives_ok(
  $$INSERT INTO public.usage_events (id, event, environment) VALUES ('00000000-0000-4000-8000-000000000001', 'instant_import_job_created', 'development') ON CONFLICT (id) DO NOTHING$$,
  'a retried insert is a no-op'
);
SELECT is(
  (SELECT count(*) FROM public.usage_events WHERE id = '00000000-0000-4000-8000-000000000001'),
  1::bigint,
  'a retry does not duplicate the row'
);

SET LOCAL ROLE anon;
SELECT throws_ok('SELECT 1 FROM public.usage_events', '42501', NULL, 'anon cannot read usage events');
SELECT throws_ok(
  $$INSERT INTO public.usage_events (id, event, environment) VALUES (gen_random_uuid(), 'x', 'production')$$,
  '42501', NULL, 'anon cannot insert usage events'
);
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT throws_ok('SELECT 1 FROM public.usage_events', '42501', NULL, 'authenticated cannot read usage events');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
