# InstantDB to Supabase

Standalone Next.js app and Workflow importer. Requires Node >=22.13 and pnpm 11.

Run pnpm dev (port 3009), pnpm test, pnpm typecheck, pnpm lint, and pnpm build. Integration and browser checks are described in README.md. Use pnpm run import for the operator CLI (pnpm import alone is a package-manager command).

- Keep SQL composed with safeSql, ident, and literal from the vendored @supabase/pg-meta helpers. Never replace these with unchecked string interpolation.
- Credentials, source rows, and file bytes must never enter Workflow arguments/results, browser telemetry, or logs.
- Workflow bodies must be deterministic; perform I/O and read clocks only inside steps.
- Generated RLS must never be more permissive than the source. Leave ambiguous rules closed and include them in the handoff.
- Use named exports except framework entry points. Preserve the Supabase components and semantic Tailwind tokens; use U.S. English.
- vendor/ is a pinned upstream snapshot. Run pnpm vendor:check to verify it. Update with the documented sync command and review upstream changes and dependencies. Do not format or casually edit vendored files.
- Environment files, uploaded backups, workflow data, and build output must never be committed.
