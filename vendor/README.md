# Supabase source snapshot

This directory contains the components, design tokens, theme provider, lint rules, and SQL helpers used by the importer, copied from `supabase/supabase`. `upstream.json` records the full commit, original path, destination path, and SHA-256 of every copied file. Fonts are included in the manifest and live in `public/fonts/`. The importer-specific telemetry types were extracted into `src/telemetry/events.ts` and are maintained locally.

Only four local workspace packages are exposed: `ui`, `ui-patterns`, `config`, and `@supabase/pg-meta`. Their package manifests and the selective `ui/index.tsx` export list are maintained here. External dependencies are pinned in the root manifest and lockfile. No packages depend on another checkout or fetch monorepo files during install/build.

Verify the snapshot:

```sh
pnpm vendor:check
```

To deliberately update it, obtain a trusted Supabase checkout and choose a full commit SHA:

```sh
pnpm vendor:sync --source /path/to/supabase --ref FULL_COMMIT_SHA
```

The script refuses to overwrite edited snapshot files and reads all upstream files before writing. It updates the existing file set only: inspect upstream imports for newly needed files, add them to the manifest, and update the local export lists and dependencies as needed. Review license changes too. Run `pnpm vendor:check`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm test:prettier`, `pnpm build`, and the applicable integration/browser tests before committing.

The code under the four package directories is declared MIT by its upstream package manifests. The broader repository is Apache-2.0 (see the root LICENSE). Font licenses are retained beside the font files. Preserve these notices when distributing the snapshot.
