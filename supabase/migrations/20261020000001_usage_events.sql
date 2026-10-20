-- Anonymous first-party usage log, written by the importer's server over its service connection.
-- No foreign key: rows outlive job cleanup. Never store messages, paths, SQL, URLs, credentials,
-- source data, or any identifier for a person or browser.
CREATE TABLE IF NOT EXISTS public.usage_events (id uuid PRIMARY KEY, occurred_at timestamptz NOT NULL DEFAULT now(), event text NOT NULL, job_id uuid, target_ref text, environment text NOT NULL, properties jsonb NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS usage_events_event ON public.usage_events(event,occurred_at);
CREATE INDEX IF NOT EXISTS usage_events_job ON public.usage_events(job_id) WHERE job_id IS NOT NULL;
COMMENT ON TABLE public.usage_events IS 'Insert-only importer usage log. Written by the server over the service connection; not readable through the Data API. Filter real usage with environment = ''production''.';

-- Supabase default privileges grant new public tables to the Data API roles. RLS with no policies
-- and revoked grants keeps the table unreachable for anon and authenticated.
ALTER TABLE public.usage_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.usage_events FROM PUBLIC, anon, authenticated;
