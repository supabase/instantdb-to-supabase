-- The upload bucket is created by migrations, private, and unreachable without the service key.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(7);

SELECT results_eq(
  $$SELECT public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'instant-import-inputs'$$,
  $$VALUES (false, NULL::bigint, NULL::text[])$$,
  'the upload bucket exists, is private, and inherits the project file-size limit'
);
-- Never add client Storage policies to the private service project.
SELECT is(
  ARRAY(SELECT format('%s.%s', tablename, policyname) FROM pg_policies WHERE schemaname = 'storage' AND tablename IN ('objects', 'buckets') ORDER BY 1),
  '{}'::text[],
  'storage.objects and storage.buckets have no policies'
);

INSERT INTO storage.objects (bucket_id, name) VALUES ('instant-import-inputs', 'pgtap/probe.jsonl');

SET LOCAL ROLE anon;
SELECT is(
  (SELECT count(*) FROM storage.objects WHERE bucket_id = 'instant-import-inputs'),
  0::bigint,
  'anon cannot see uploaded backups'
);
SELECT throws_ok(
  $$INSERT INTO storage.objects (bucket_id, name) VALUES ('instant-import-inputs', 'pgtap/anon.jsonl')$$,
  '42501', NULL, 'anon cannot upload backups'
);
SELECT is(
  (SELECT count(*) FROM storage.buckets WHERE id = 'instant-import-inputs'),
  0::bigint,
  'anon cannot see the upload bucket'
);
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT count(*) FROM storage.objects WHERE bucket_id = 'instant-import-inputs'),
  0::bigint,
  'authenticated cannot see uploaded backups'
);
SELECT throws_ok(
  $$INSERT INTO storage.objects (bucket_id, name) VALUES ('instant-import-inputs', 'pgtap/user.jsonl')$$,
  '42501', NULL, 'authenticated cannot upload backups'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
