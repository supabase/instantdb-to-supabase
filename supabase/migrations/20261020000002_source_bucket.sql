-- Private bucket for uploaded backups (src/workflow/source.ts). Only the server's service-role
-- key reaches it; never add storage.objects policies for it. No bucket file-size limit or MIME
-- allowlist: uploads inherit the project's global Storage limit, which must fit the largest file.
-- Re-applying keeps the bucket private even if it was created by an older runtime or flipped.
INSERT INTO storage.buckets (id, name, public)
VALUES ('instant-import-inputs', 'instant-import-inputs', false)
ON CONFLICT (id) DO UPDATE SET public = false;
