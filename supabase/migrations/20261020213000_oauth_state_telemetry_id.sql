-- Carries the browser's in-memory analytics ID across the Supabase OAuth redirect.
ALTER TABLE instant_import_service.oauth_states ADD COLUMN IF NOT EXISTS telemetry_id uuid;
