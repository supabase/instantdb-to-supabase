-- Private job store for the importer's service project. This baseline reproduces the schema the
-- app previously created at runtime, so every statement is idempotent: applying it to a service
-- project that was already initialized by the app is a no-op.
CREATE SCHEMA IF NOT EXISTS instant_import_service;
REVOKE ALL ON SCHEMA instant_import_service FROM PUBLIC;

CREATE TABLE IF NOT EXISTS instant_import_service.jobs (id uuid PRIMARY KEY, target_ref text NOT NULL, phase text NOT NULL DEFAULT 'uploading', revision bigint NOT NULL DEFAULT 0, cursor jsonb NOT NULL DEFAULT '{"index":0,"after":"","offset":0}', config bytea NOT NULL, model bytea, error_code text, cancel_requested boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS instant_import_service.targets (target_ref text PRIMARY KEY, job_id uuid NOT NULL REFERENCES instant_import_service.jobs(id));
CREATE TABLE IF NOT EXISTS instant_import_service.files (job_id uuid REFERENCES instant_import_service.jobs(id), id uuid NOT NULL, path text NOT NULL, path_key text NOT NULL, object_key text NOT NULL, size bigint NOT NULL CHECK(size>=0), sha256 text NOT NULL, kind text NOT NULL, namespace text, byte_offset bigint NOT NULL DEFAULT 0, upload_url text, etag text, hash_state bytea, verified boolean NOT NULL DEFAULT false, PRIMARY KEY(job_id,id), UNIQUE(job_id,path_key), UNIQUE(job_id,object_key));
CREATE TABLE IF NOT EXISTS instant_import_service.rows (job_id uuid NOT NULL REFERENCES instant_import_service.jobs(id), namespace text NOT NULL, id uuid NOT NULL, raw bytea NOT NULL, normalized bytea NOT NULL, created_at bigint NOT NULL, presence text[] NOT NULL, PRIMARY KEY(job_id,namespace,id));
CREATE TABLE IF NOT EXISTS instant_import_service.edges (job_id uuid NOT NULL REFERENCES instant_import_service.jobs(id), link text NOT NULL, source_id uuid NOT NULL, target_id uuid NOT NULL, PRIMARY KEY(job_id,link,source_id,target_id));
CREATE INDEX IF NOT EXISTS edges_reverse ON instant_import_service.edges(job_id,link,target_id,source_id);
CREATE TABLE IF NOT EXISTS instant_import_service.unique_values (job_id uuid NOT NULL REFERENCES instant_import_service.jobs(id), namespace text NOT NULL, field text NOT NULL, digest text NOT NULL, value bytea NOT NULL, entity_id uuid NOT NULL);
CREATE INDEX IF NOT EXISTS unique_lookup ON instant_import_service.unique_values(job_id,namespace,field,digest);
CREATE TABLE IF NOT EXISTS instant_import_service.blobs (job_id uuid NOT NULL REFERENCES instant_import_service.jobs(id), id uuid NOT NULL, source_file uuid NOT NULL, metadata bytea NOT NULL, size bigint NOT NULL, included boolean NOT NULL DEFAULT true, PRIMARY KEY(job_id,id));
CREATE TABLE IF NOT EXISTS instant_import_service.transfers (job_id uuid NOT NULL REFERENCES instant_import_service.jobs(id), id uuid NOT NULL, upload_url text, byte_offset bigint NOT NULL DEFAULT 0, verified_byte_offset bigint NOT NULL DEFAULT 0, hash_state bytea, storage_id uuid, storage_version text, PRIMARY KEY(job_id,id));
CREATE TABLE IF NOT EXISTS instant_import_service.artifacts (job_id uuid NOT NULL REFERENCES instant_import_service.jobs(id), name text NOT NULL, bytes bytea NOT NULL, PRIMARY KEY(job_id,name));
CREATE TABLE IF NOT EXISTS instant_import_service.browser_jobs (job_id uuid PRIMARY KEY REFERENCES instant_import_service.jobs(id) ON DELETE CASCADE, session_hash text NOT NULL, target_encrypted bytea NOT NULL, file_count integer NOT NULL, selection_hash text NOT NULL, run_id text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS instant_import_service.oauth_states (state_hash text PRIMARY KEY, session_hash text NOT NULL, cookie_hash text NOT NULL, verifier bytea NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS instant_import_service.oauth_connections (session_hash text PRIMARY KEY, tokens bytea NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS instant_import_service.oauth_database_credentials (session_hash text NOT NULL REFERENCES instant_import_service.oauth_connections(session_hash) ON DELETE CASCADE, project_ref text NOT NULL, credential bytea NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(session_hash,project_ref));
CREATE TABLE IF NOT EXISTS instant_import_service.platform_cooldowns (scope text PRIMARY KEY, retry_at timestamptz NOT NULL, failures integer NOT NULL, status integer NOT NULL);

-- Columns added after the first runtime-initialized deployments.
ALTER TABLE instant_import_service.browser_jobs ADD COLUMN IF NOT EXISTS telemetry_id uuid;
ALTER TABLE instant_import_service.transfers ADD COLUMN IF NOT EXISTS storage_version text;

-- No client role can inspect source rows or credentials.
ALTER TABLE instant_import_service.platform_cooldowns ENABLE ROW LEVEL SECURITY;
ALTER TABLE instant_import_service.oauth_database_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE instant_import_service.oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE instant_import_service.oauth_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE instant_import_service.browser_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE instant_import_service.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE instant_import_service.targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE instant_import_service.files ENABLE ROW LEVEL SECURITY;
ALTER TABLE instant_import_service.rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE instant_import_service.edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE instant_import_service.unique_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE instant_import_service.blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE instant_import_service.transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE instant_import_service.artifacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON SCHEMA instant_import_service FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA instant_import_service FROM PUBLIC, anon, authenticated;
