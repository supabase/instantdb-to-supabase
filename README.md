# InstantDB to Supabase Migration

A Next.js 16.3.4 standalone app containing a tested Node.js importer for **extracted Instant backup files**. The importer creates conventional relational application tables in the **public schema** of a blank Supabase project. Table and column names use readable snake_case; import bookkeeping is temporary and removed after verification. The import page requires a Supabase OAuth connection, an extracted folder, and a selected blank project; imports can run through Workflow v5 with durable, bounded batches or through the small-input command-line worker.

Input is a folder containing `config.json`, `entities/*.jsonl`, and `files/<location-id>`. ZIP files are not accepted. Empty directories are optional. The importer reads only this folder and the destination; it never connects to Instant or follows source file URLs.

## Development

```sh
pnpm install --frozen-lockfile
cp .env.example .env.local
# Fill in the server-only values before testing OAuth or imports.
pnpm dev
```

Open http://localhost:3009/migrate/instantdb. Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm test:prettier`, and `pnpm build` before committing. The unit suite also runs the upstream SQL-formatting tests. `pnpm test:browser` uses a production build and starts port 3009 unless `IMPORT_WORKFLOW_TEST_URL` points to a separate preview. Integration tests require disposable local projects; never point test credentials at a hosted project.

This repository is independent of the Supabase monorepo. The four packages under `vendor/` resolve locally; installing or building does not need the upstream checkout. See [vendor/README.md](vendor/README.md) for provenance and update instructions.

## OAuth configuration

Register a Supabase platform OAuth application with `http://localhost:3009/migrate/instantdb/api/supabase/callback` for local development and your deployment's HTTPS callback for production. Configure `IMPORT_OAUTH_CLIENT_ID`, `IMPORT_OAUTH_CLIENT_SECRET`, and `IMPORT_OAUTH_REDIRECT_URI` from that application. The importer requests its required scopes when connecting; approve access only to the projects you intend to migrate into.

The three `IMPORT_JOB_*` settings point to a separate private service project, not the destination. This repository's `supabase/` folder is that service project: `supabase/migrations` is the only source of its schema, and the app never creates tables at runtime. For local development, run `supabase start` in the repository root (it applies the migrations on ports 553xx, clear of a destination on the default 543xx ports) and copy `DB_URL`, `API_URL`, and the service-role key from `supabase status` into the `IMPORT_JOB_*` settings. Set `IMPORT_CREDENTIAL_KEY` to a stable base64-encoded 32-byte secret. Existing service data requires its original key; do not generate a replacement when moving or redeploying this app. All credentials remain server-only. Optional PostHog settings are documented at the end of this file.

## Browser import

The UI uses Studio page, card, and form components. The top-right theme menu supports Light, Dark, and System; the preference is saved in the browser.

Cache Components and Partial Prefetching are enabled. The landing page prerenders without credentials; deployment readiness, OAuth state, and import progress are loaded through uncached requests. The current app has one page and no Next.js Link or imperative prefetch calls, so there are no full-prefetch navigations to migrate. Use the production build for browser tests; development Strict Mode can repeat mount-time requests.

When presenting a migrated concept, show its source representation alongside the relevant Supabase SQL and briefly explain the mapping. Keep supporting SQL expandable and distinguish statements verified against the completed import from suggestions that have not run. Applied policies follow this pattern with source rules, `CREATE POLICY` and table grants. Teach the SQL concepts at the point where users encounter them rather than requiring prior Postgres knowledge.

Configure the three `IMPORT_JOB_*` variables below plus `IMPORT_CREDENTIAL_KEY`, a stable base64-encoded 32-byte encryption key. Generate it with `openssl rand -base64 32` and keep it in your secret manager; changing it prevents existing browser jobs from resuming. Then run `pnpm dev` and open http://localhost:3009/migrate/instantdb. The operator registry and bearer token are not required for browser imports.

Connect Supabase first, then select an extracted folder and an authorized project. The server discovers the session pooler and obtains temporary database credentials through OAuth. Project URLs, passwords, and API keys never need to be entered in the browser. Configure platform OAuth as described above.

Uploads go directly to private Storage with signed resumable 6 MiB TUS chunks. The browser hashes each file in bounded chunks; no whole backup is buffered or sent through a Next request. This first UI supports up to 10,000 files and an 8 MiB configuration. Pause and resume with the same folder, or reload the job URL in the same browser. After upload, processing continues without the tab.

Progress comes from Workflow SDK run status and completed import step outputs. The UI follows continuation runs and shows retries and phases, without estimating a total percentage. Completed jobs link to the project’s Table Editor, migrations, RLS policies, Auth, and Storage. The handoff provides CLI commands and an expandable, copyable coding-agent prompt for every unresolved policy and setup item. Converted rules with access warnings also appear as review tasks, alongside their applied SQL; downloads are not part of the browser flow. Cancellation stops at a batch boundary and does not undo completed writes.

A random HttpOnly, SameSite session cookie binds jobs, handoff prompts, and audit artifacts to the browser. Destination credentials are encrypted with AES-256-GCM in the private service database and never placed in Workflow arguments or browser storage. Platform OAuth supplies project selection and API credentials; see the OAuth configuration section below. The OAuth flow has passed local regression tests and a live hosted-project authorization.

Run `pnpm test:browser` against a running importer and a **disposable blank local** destination using the `IMPORT_TEST_*` variables. The browser suite covers the OAuth-only UI contract with mocked project responses and rejects manual credentials at the real browser API boundary. Worker integration suites separately cover local database restores.

## Vercel deployment

Deploy this repository root, including `vendor/` and `public/fonts/`, using Node.js 24, `pnpm install --frozen-lockfile`, and `pnpm build`. Keep local environment files, workflow data, backups, and context reports out of deployment uploads.

Configure all seven variables in `.env.example` for production. Use a hosted private service project and a direct or session database connection; hosted Supabase connections verify the server certificate against the bundled Supabase CA. Apply the service schema before deploying the app, and again whenever `supabase/migrations` changes:

```sh
supabase link --project-ref SERVICE_PROJECT_REF
supabase db push
```

The baseline migration is idempotent, so `db push` is safe on a service project that an earlier version of the app initialized at runtime. Until the migrations are applied, requests fail with a 503 and the server log names the missing step. The database login needs ordinary read/write access to the service tables. Store credentials as sensitive Vercel environment variables, and keep the encryption key stable across deployments.

Register the production HTTPS `/migrate/instantdb/api/supabase/callback` URL in the OAuth application and use that exact URL for `IMPORT_OAUTH_REDIRECT_URI`. In production that is `https://supabase.com/migrate/instantdb/api/supabase/callback`: supabase.com proxies `/migrate/instantdb/*` to this deployment, and the bare deployment root redirects there. Set the private service project's Storage file-size limit to accommodate your largest input file; the default 50 MB is too small for large backups (the local `supabase/config.toml` uses 50 GiB). The private `instant-import-inputs` upload bucket is created by `supabase/migrations` and has no bucket-level size limit, so it inherits the project limit; the app only checks that it exists and is private, and refuses uploads otherwise.

Use this repository root as the Vercel project's Root Directory and `pnpm build` as its Build Command. `vercel.json` pins the Install Command to `pnpm install --frozen-lockfile` and selects Singapore; keep functions near the service database. Workflow uses Vercel's managed runtime automatically; do not deploy the local `WORKFLOW_TARGET_WORLD` or `WORKFLOW_LOCAL_DATA_DIR` overrides. After deployment, verify `/migrate/instantdb/api/health`, the OAuth round trip, and signed resumable uploads.

## Durable imports with Workflow v5

Use this path for large backups. The app pins `workflow@5.0.0-beta.47`; v5 is a prerelease. The immediately newer beta depended on an unpublished package when this was installed. The Next build uses Webpack because the Turbopack build stalled during the original monorepo implementation. The browser UI obtains temporary destination credentials through Supabase platform OAuth. Each batch and retry opens a new connection, renewing expired credentials before connecting; a five-minute login lifetime does not limit the import duration.

Provision **two separate Supabase projects**: a private service project for jobs and uploaded inputs, and a blank destination. Both SQL connections must be direct or session connections. Configure these server-only environment variables using your normal secret manager or an ignored local environment file:

| Variable                      | Value                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `IMPORT_JOB_DATABASE_URL`     | Privileged SQL connection to the service project                                                |
| `IMPORT_JOB_SUPABASE_URL`     | Service project's API URL                                                                       |
| `IMPORT_JOB_SERVICE_ROLE_KEY` | Service project's secret/service-role key                                                       |
| `IMPORT_TARGETS_JSON`         | Operator registry: `{"destination":{"databaseUrl":"…","supabaseUrl":"…","serviceRoleKey":"…"}}` |
| `IMPORT_WORKFLOW_TOKEN`       | Long random bearer token for the operator HTTP API                                              |

The destination reference is the registry key, such as `destination`. Credentials, row contents, file bytes, and resumable upload URLs never become Workflow arguments or results. Workflow receives a job UUID and small status values. The private service schema enables RLS and revokes application-role access; source objects live in a private `instant-import-inputs` bucket.

```sh
# Upload extracted files with streaming SHA-256 and resumable 6 MiB TUS chunks.
pnpm import:workflow --input /path/to/backup --target destination

# If upload is interrupted, reselect the identical folder and use the printed job UUID.
pnpm import:workflow --input /path/to/backup --target destination --job JOB_UUID

# Run the Next app with the same environment. Local Workflow state is in .workflow-data/.
pnpm dev

# Start or resume processing after upload has frozen the input manifest.
curl -X POST -H "Authorization: Bearer $IMPORT_WORKFLOW_TOKEN" \
  http://localhost:3009/migrate/instantdb/api/import-jobs/JOB_UUID

# Inspect phase, revision, error code, and cancellation status.
curl -H "Authorization: Bearer $IMPORT_WORKFLOW_TOKEN" \
  http://localhost:3009/migrate/instantdb/api/import-jobs/JOB_UUID

# Request cancellation at the next batch boundary. This does not delete data.
curl -X DELETE -H "Authorization: Bearer $IMPORT_WORKFLOW_TOKEN" \
  http://localhost:3009/migrate/instantdb/api/import-jobs/JOB_UUID

# Export completed migration files, permission reports, and verification totals.
pnpm import:workflow --job JOB_UUID --output /path/to/artifacts
```

The CLI prints the job UUID before uploading bytes, allowing recovery from interrupted uploads. It checks local hashes again on resume and verifies server hashes before schema creation. A stopped Workflow run retains its checkpoint; POST the same job UUID to retry. The status endpoint reports `failed` after step retries are exhausted, alongside the retained phase. Duplicate starts are safe but may create redundant Workflow runs. `--run-local` runs the same checkpoint engine directly for debugging, without exercising the Workflow scheduler.

The pipeline stages and validates all source records before destination mutation, then creates tables, imports native accounts and files, loads scalar rows, writes relationships, adds constraints, verifies data, and exports reports. Rows are limited to **500 records and approximately 2 MiB of raw plus normalized data per database batch**. Source reads are at most 3 MiB plus one byte; individual records are limited to 1 MiB. Relationship batches contain at most 1,000 edges, Auth batches at most five accounts, and file transfer/hash batches at most 6 MiB. Workflows continue into a new run after 200 steps so event history does not grow with the complete database. Input size and total row count have no whole-backup materialization limit on this path.

A destination batch commits its writes and receipt in one transaction. The service checkpoint commits afterward, so a lost acknowledgment replays the receipt without duplicating data. Constraints are added after relationships to allow cycles across committed row batches. The baseline and each subsequent constraint change are recorded atomically in Supabase migration history and exported as ordered migration files. Supported direct RLS policies are applied after verification; unresolved operations remain closed. A final retry-safe step removes destination bookkeeping after reports are durably saved in the service. Customer migrations contain only application objects.

Large imports require adequate **service database disk, source object storage, and destination disk**. Staging keeps raw and normalized records plus indexes; the destination temporarily holds verification records alongside relational data, then removes those records at completion. Set both projects' Storage file-size limits high enough for the largest JSONL/blob file before uploading. TUS does not bypass project or plan limits. Schema/index/constraint operations still run as individual SQL statements, with a 120-second query timeout; exceptionally large tables or slow destinations may need further tuning. Source manifest/config/schema complexity limits below still apply. Successful imports remove both source backups and temporary staging before completion. Failed and abandoned jobs retain their inputs. Browser uploads and the import UI use the OAuth configuration below. Preserve the private service database and local Workflow data across restarts; on Vercel use its managed Workflow runtime rather than ephemeral local disk.

Cancellation retains partial resources and blocks another job from taking over a destination that has been touched. Cancellation before destination work releases its service ownership claim. There is no automatic rollback of an entire multi-batch import. Use a new blank destination when intentionally abandoning a partially imported project. Schema drift, source hash changes, or unexpected Auth/Storage ownership stop progress rather than overwrite data.

## Small-input command-line import

From the repository root:

```sh
pnpm install
pnpm dev

# Validate and write a plan without contacting or changing a destination.
pnpm run import --input /path/to/backup --output /path/to/artifacts

# Set credentials for the same blank destination in the environment.
# IMPORT_DATABASE_URL: privileged direct/session Postgres connection
# IMPORT_SUPABASE_URL: destination API URL
# IMPORT_SERVICE_ROLE_KEY: destination service-role or secret key
pnpm run import --input /path/to/backup --output /path/to/artifacts --apply
```

Use `run import`: `pnpm import` is a different, built-in pnpm command. Connection URLs and keys are read only from environment variables. Keep credentials out of shell arguments, source control, and browser code. A session connection is required for the advisory restore lock; transaction poolers are unsupported. Postgres TLS settings follow the connection URL and normal `pg` validation; the importer does not disable certificate verification.

This is a trusted operator entry point, not the eventual customer connection flow. Password-free Cloud provisioning remains future work. The browser path supports resumable uploads and platform OAuth. The separate Workflow path above implements service-owned jobs and durable orchestration. Point all three credentials at the same destination. The importer verifies SQL visibility of created Auth and Storage resources; a misconfigured cross-project credential can still create a partial resource before that check fails.

The destination must have no application tables, users, Storage buckets, Storage policies, or custom triggers on `auth.users`. Supabase system schemas are allowed. Resume permits only the current job's resources. No existing application is merged or overwritten.

## What is restored

- Application namespaces as ordinary public tables, including empty ones: `tasks`, `projects`, and `task_comments`. System namespaces map to native Supabase services; there are no duplicate public `files`, `users`, `oauth_providers`, or `streams` tables. There are no generic entity/attribute tables or hash prefixes on ordinary names. Suffixes are used only to resolve identifier collisions or the Postgres identifier-length limit.
- Original entity UUIDs, scalar/JSON attributes, unknown application attributes, and normalized declared date attributes. The backup snapshot is restored without an internal row-version history. Application history tables such as `documentVersions` remain ordinary data and are imported in full.
- Exact JSON record bytes, outer creation metadata, and field presence are used temporarily for verification. Keep the extracted backup for original representations after destination cleanup. Strings/JSON containing NUL use reversible UTF-8 JSON `bytea` columns.
- One-to-many relationships become foreign keys on the many side: `tasks.project_id`, `task_comments.task_id`, and native Storage object references such as `profiles.avatar_id`. One-to-one relationships add a unique FK, such as `profiles.user_id`. Many-to-many relationships create junction tables, such as `tasks_labels(task_id, label_id)`. When the one-valued side is managed by Auth or Storage and cannot accept application columns, use a junction with the corresponding unique constraints. Never add columns or triggers to managed tables. Both source directions are reconstructed and verified from those physical columns. Required FK columns use NOT NULL; source cascades on the FK-owning side use ON DELETE CASCADE, optional references otherwise use SET NULL, and required references otherwise use deferred NO ACTION. Endpoint deletion removes junction rows, not related entities. All FKs are deferred to support cycles and arbitrary row order.
- Native NOT NULL constraints for declared required attributes, with the computed file URL exception.
- Standard B-tree indexes and native unique constraints for ordinary scalar attributes. JSON, encoded attributes, and source strings exceeding 1 KiB use hash indexes; source uniqueness in those fields is validated during import, but future enforcement needs a manual constraint task. No custom trigger is generated; automatic INSERT/UPDATE policies remain closed until it is resolved. Ordinary native B-tree constraints retain Postgres's key-size limits for future writes.
- Auth owns login identities. Identity-only users map directly to `auth.users`; custom user fields or users without portable credentials create `public.user_accounts` with an optional, unique `auth_user_id` FK. Existing application `profiles` stay separate, preserving their IDs and links. The domain table omits email and source identity type; original values remain available in the backup. Email users receive the same UUID in Auth as an unconfirmed account, without password, source session, email delivery, or inferred verification. Guests remain logical records without a destination identity claim. Provider names do not establish provider subjects.
- Application file bytes through Storage APIs in a private job bucket, including shared source blobs, empty files, and Unicode logical paths. Scalar and junction file links reference native `storage.objects(id)`. Each logical file gets a distinct object keyed by its logical UUID, even when source bytes were shared; this preserves independent file links and cardinalities. Original path and content disposition are stored in Storage user metadata (NUL-containing strings use explicitly named base64 fields). Only custom file attributes create a `public.file_metadata` table with a native object FK. Source-to-object mappings are used temporarily for verification; source UUIDs remain the Storage object names. Every object is downloaded and fully hashed after upload; target UUID, size, content type, and original metadata are checked separately. Deleting an object through Storage applies the generated FK deletion behavior to application references; deleting application rows does not delete objects.
- Provider records become Supabase Auth setup diagnostics; the original records stay in the backup. Names alone do not configure a provider or prove any user identity.
- Realtime, rooms, presence, streams, stream links, and stream-only files are explicitly outside this migration tool's scope. Application files also referenced by streams still migrate. Excluded rows are not retained in the destination; keep the input backup for excluded file bytes. Reports distinguish original source totals from verified imported totals.
- Original configuration bytes, including rules, templates, webhooks, redirects, and historical system metadata. These are preserved as data. The permission converter parses a bounded rule subset and generates SQL; it never evaluates source code.

Analysis checks duplicate JSON keys, lossy/overflowing numbers, invalid UTF-8, invalid dates and UUIDs, counts, required values/links, both link cardinalities, endpoint integrity, uniqueness, file sizes, missing/orphan blobs, path collisions, symlinks, and explicit resource limits. It does not silently skip bad records. Known OS packaging metadata is reported as ignored.

## Completion and recovery

The result is always `restored_setup_required`. Public tables have RLS enabled. Workflow imports apply supported direct policies and grants; unresolved operations and Storage stay closed. The small CLI outputs supported SQL for a separate application step. The `public` schema controls table organization, not access policy. This pass restores durable data; **it does not activate an equivalent Instant application backend**.

Field redaction, graph mutation APIs, inverse required-link enforcement on future mutations, non-FK-direction entity cascades, rate limits, signup rules, provider configuration and webhooks are not implemented here. Graph import validation is not a claim that all future graph mutation semantics are enforced. Unsupported permission behavior is reported for manual conversion; it does not block importing data. Realtime and streams are excluded from the product, not pending activation tasks. Fallback hash indexes support equality; normal scalar indexes support ordered queries. The permission converter only emits readable conditions directly in RLS policies. Graph traversals, profile lookups, field restrictions, and complex behavior become scoped agent prompts; no permission helper schemas or functions are generated.

The folder's canonical path/size/SHA-256 manifest and model version determine the private import schema (`instant_v3_<hash>`). Application tables always live in `public`. Repeating the command with identical files resumes an interrupted job. Completed imports remove the ledger and are not reimported into a populated project. Changing file bytes produces a different import identity and will fail the blank-project check if the previous import is still present.

Database DDL, empty application tables/constraints, private provenance/mappings, and the initial ledger commit in one transaction. Auth and Storage are then provisioned through their APIs in resumable stages. After native IDs are verified, all application rows and mapped relationships commit atomically with a durable `data_loaded` marker. A failed application load rolls back all application inserts and can resume using the existing owned Auth/Storage resources. A per-project advisory lock excludes concurrent workers. Interrupted jobs reconcile owned Auth users and verify existing objects before continuing. Uploads never use overwrite/upsert. A recorded bucket intent permits recovery before bucket creation; a previously verified bucket disappearing is treated as drift.

Each rerun verifies typed rows, source bytes, edges, identity/file mappings, and a catalog fingerprint covering columns, constraints, indexes, triggers, functions, policies, and grants. Changed resources stop recovery rather than being replaced. The final ledger revision advances only after verification. A hard interruption leaves the state `restoring` and private resources available for a rerun; there is no background retry scheduler, cancellation interface, or automatic cleanup in this pass. Admin changes during execution cannot be prevented by this tool's lock. Recheck after external changes and never treat the report as ongoing monitoring.

Cross-service failures can leave partial Auth accounts and objects. Rerun the same input and credentials to resume. If the error reports drift or a conflict, inspect the affected private job resources first. Do not drop the destination project or remove unrelated resources. For local tests, use the disposable project's own `supabase stop --workdir ... --no-backup` after testing. No production cleanup command is provided yet.

## Permission conversion

Every analysis, including a dry run, produces `permissions.sql`, `permissions.json`, and `permissions-manual.md`. The small-input CLI leaves this SQL unapplied. The browser/Workflow importer applies the deterministic statements after verification and records a security migration atomically with the completion receipt. A lost service checkpoint verifies the existing migration and does not apply it again. The report includes effective CRUD rules, their source/default paths, original expressions and bindings, mapped targets, conversion status, and reasons and suggestions for manual work, including converted rules that still need review (implicit-default grants and identity comparisons that match NULL ownership columns for anonymous requests). It also retains the entire original rules object, unknown configuration, shadowed defaults, and binding definitions. No rule strings are evaluated or substituted into SQL.

Supported rules include explicit allow/deny, signed-in checks, scalar ownership comparisons, boolean operators, null equality, numeric comparisons, literal-list membership, and bindings. Schema-defined `data.ref` membership checks support `auth.id` across up to eight FK/junction links in either direction, ending at `id` or a required scalar field. `auth.ref('$user.…')` supports literal role/ID membership. Helpers resolve the source account through `auth_user_id` when `user_accounts` exists and evaluate the graph without recursive RLS. Missing users and empty relationships do not match.

Updates using row data, request parameters/metadata, submitted-field checks, rate limits, unsupported functions, and native Auth/Storage rules require manual implementation. Field restrictions keep the entire table's client operations closed, including a nominally public view. Deletes involving relationships and creates requiring reference checks also remain manual. There is no partial conversion of an unsupported expression, even inside an otherwise supported OR branch.

Generated grants cover source scalar columns and IDs. Clients cannot update IDs or read/write generated relationship columns or junction tables; those receive separate manual-work entries. Query explicit scalar columns on tables with generated FKs. Updates and deletes also depend on the SELECT policy, and INSERT RETURNING needs SELECT access. These are SQL access contracts, not a replacement for source graph transactions. Storage buckets remain private. Native Auth signup and provider behavior requires separate service configuration; application RLS does not enforce it.

For browser imports, run `supabase login`, `supabase link --project-ref <ref>`, and `supabase migration fetch --linked` in the application directory (`supabase init` first if needed). This fetches schema, constraint, and security migrations without copying SQL from a download. Run each handoff prompt in that directory to implement unresolved behavior in a new local migration; review and test before `supabase db push`. For small-input CLI imports, review and apply the generated permission SQL separately. The generated SQL rejects existing application policies and rolls back on failure; it is not an update/merge tool. The report's `applied` field records what the importer did; it does not monitor subsequent user changes.

Changing policies or grants intentionally ends the data import's resume phase: later restore attempts detect catalog drift. The existing import metadata and provenance schema remains private; generated authorization helpers use a separate schema with a fixed search path, explicit client EXECUTE grants, and PUBLIC execution revoked. Keep that helper schema out of exposed API schemas.

## Migration history and local development

Schema creation records one baseline migration in `supabase_migrations.schema_migrations`, using the same SQL helpers as Studio. It appears under Database → Migrations with its name, UTC timestamp version, and complete SQL. The exact generated DDL statements and their order are retained, including function bodies, indexes, constraints, RLS, and private helper definitions; statements are not split on semicolons. No application rows, Auth accounts, file bytes, credentials, or history-table inserts are embedded in the migration.

The migration entry and schema commit in the same transaction. If recording history fails, the schema rolls back. If Auth or Storage later interrupts, the applied schema migration remains valid. Resume verifies the stored name and SQL against the plan, keeps the same version, and rejects deleted or modified history. Existing history entries are preserved, timestamp collisions receive the next available second, and legacy version-only history tables gain the supported name/statements columns.

After a successful apply, the artifacts also contain `migrations/<version>_<name>.sql`. Copy this file into a local Supabase project's `supabase/migrations` folder, or fetch the history through the CLI:

```sh
# For a linked Cloud project:
supabase migration fetch --linked

# For the current local example:
supabase migration fetch --local --workdir /path/to/local-supabase-project
```

Replaying the migration creates empty schemas and tables; importing records, Auth identities, and Storage objects remains a separate operation. Dry runs still emit `schema.sql`; the final versioned filename is assigned when the schema transaction runs. Imports created before migration-history support require an explicit verified registration or a fresh import, not automatic history repair. The current local example has been verified and registered without recreating application data or native resources.

## Artifacts and data handling

`--output` receives a subdirectory named by content hash:

- `manifest.json`: source namespaces and their public/native/excluded destinations, public column names, each link's FK or junction mapping, private metadata schema, storage encodings, source/imported counts, and setup requirements; no row values or identity list.
- `migrations/<version>_<name>.sql`: after apply, the schema migration recorded in Supabase history and ready for local replay.
- `schema.sql`: the generated DDL transaction. It contains no source rows or credentials and is **not** a complete standalone data restore.
- `permissions.sql`: converted policies and grants as an unapplied transaction for a separate post-import migration.
- `permissions.json`: complete source rules and per-operation conversion results, with manual-work reasons and suggestions.
- `permissions-manual.md`: readable checklist of unresolved rules, relationship operations, and converted rules that need review.
- `verification.json`: verified totals, content identity, private resource names, migration version/name/filename, revision, and remaining setup work after a successful apply.

Artifacts are created with restrictive local permissions. Permission reports and SQL can contain sensitive rule literals; keep them out of public logs and source control unless reviewed. Temporary destination bookkeeping and provenance are removed after verification. After successful verification, Workflow deletes uploaded source objects in batches of 100 and staged records in batches of 1,000 before marking the job completed. Cleanup retries from its committed checkpoint; failed or canceled imports retain their input for investigation/retry. Keep the original local backup. Only schema mappings, source rules, diagnostics, totals, and private completion reports remain; original configuration values are removed. Public application tables require verified RLS before granting client access.

## Limits

The small-input `run import` command materializes a bounded folder and plan in memory: 128 MiB total file bytes, 32 MiB per file, 8 MiB configuration, 1 MiB per record, 10,000 entries, 100,000 rows, 512 namespaces, 512 attributes per namespace (declared or discovered from rows), 2,048 relationships, and JSON depth 64. These are validation limits, **not** large-import performance certification. Numbers must round-trip through JavaScript's double representation without changing the decimal value. Dates support integer epoch milliseconds or ISO timestamps with explicit timezone and at most millisecond precision; unsupported precision blocks import rather than truncating it.

The Workflow path streams and stages input instead of raising the small-input command's limits. A disk-backed 2 GiB JSONL reader/hash benchmark processed 262,144 records in 1,024 batches with a maximum read of 1,048,577 bytes and about 196 MiB peak process RSS. This is reader validation, not a full 2 GiB database restore benchmark or a production throughput guarantee. Run it with `pnpm exec node --import tsx scripts/benchmark-reader.ts --gib 2`.

## Tests

```sh
pnpm test
pnpm test:coverage
pnpm typecheck
pnpm lint
pnpm format
pnpm test:prettier
pnpm build
pnpm test:db
```

`pnpm test:db` runs the pgTAP suites in `supabase/tests/database` against the local service project (`supabase start` in the repository root). They check that the service schema, `public.usage_events`, and the upload bucket exist, that every `instant_import_service` and `public` table has RLS enabled with no policies, and that `anon` and `authenticated` can neither read nor write them or uploaded backups. The RLS and privilege checks scan the catalog, so a table added by a later migration is covered automatically.

For integration tests, initialize a **separate disposable** local Supabase project with the CLI. Enable Auth and Storage; the repository's existing project is not used. Export `IMPORT_TEST_DATABASE_URL`, `IMPORT_TEST_SUPABASE_URL`, and `IMPORT_TEST_SERVICE_ROLE_KEY` from that project's `supabase status --output json`. Tests require localhost URLs, fail when configuration is absent, and remove only resources they created.

```sh
# Optional: also test the supplied example, already extracted locally.
export IMPORT_EXAMPLE_PATH=/path/to/extracted-example
pnpm test:integration

# Combined coverage, including real SQL, Auth, and Storage execution:
pnpm exec vitest run --coverage
```

Permission tests run generated SQL as anonymous and authenticated roles, verify simple row predicates and owner-only inserts, keep graph references and profile-identity lookups closed for manual work, reject relationship updates, and confirm no helper functions are created. Integration files run serially because they share the disposable public schema.

Synthetic fixtures are checked in. The supplied real backup is not. Integration tests cover rollback, interruption/replay, duplicate delivery, ownership conflicts, schema/data/file drift, private access, full file hashes, logical guests, Auth UUID preservation, float boundaries, NUL encoding, long unique values, and concurrent writes. The example source contract is 598 records across 37 namespaces, 49 links/1,881 edges, and nine logical files/603 bytes. The native destination contains 584 application rows in 34 public entity tables, nine junction tables, 38 FK mappings, 1,878 imported edges, seven Storage objects/531 bytes, and five unconfirmed Auth users. The excluded records are three provider configuration records, two streams, and two stream-only files. Six logical accounts, including one guest, remain in `user_accounts`; five link to Auth. Original source records remain in the user’s local backup; uploaded backups, private service staging, and temporary destination provenance are removed at completion.

Model version 3 maps platform namespaces to native services and excludes Realtime. The CLI targets blank projects and resumes only matching version 3 jobs; it does not silently upgrade version 1 or 2 jobs. The native example is imported into a fresh local project, with the previous example retained separately for comparison.

### Workflow validation

Workflow integration tests additionally require a second disposable local Supabase project and the three `IMPORT_JOB_*` variables above. Start the service project with `supabase start` in the repository root so its migrations are applied; the tests check that schema and configure a `test` destination reference. For the actual HTTP runtime test, start the Next app with `IMPORT_TARGETS_JSON` pointing `test` at the same disposable destination, set `IMPORT_WORKFLOW_TOKEN=local-workflow-test-token` only in that isolated test environment, and pass `IMPORT_WORKFLOW_TEST_URL` to Vitest. The CI workflow runs both projects and this runtime test. The supplied backup remains optional and is never checked in.

Coverage includes byte and row limits, offsets beyond 4 GiB, SHA-256 continuation, UTF-8/CRLF boundaries, truncated/changed range responses, expired upload URLs, upload acknowledgment offsets, cross-batch duplicate IDs and relationships, empty/shared/multi-chunk files, native identities, receipt replay, cancellation, schema drift, staging privacy, workflow continuation, and simultaneous HTTP starts. The new Workflow destination ledger is version 4 and is intentionally separate from existing version 3 CLI restores. Existing imported projects are not upgraded implicitly. The retained development example was updated with an explicit, data-verified simplification migration.

## Product analytics

Tracking is disabled until `IMPORT_POSTHOG_KEY` (a PostHog project token, not a personal API key) and `IMPORT_POSTHOG_HOST` are set. Use the ingestion host for that project, such as `https://eu.i.posthog.com` or `https://us.i.posthog.com`. An existing PostHog project works; a separate project is optional. Configure production environment variables only. Local and preview deployments stay disabled unless explicitly enabled with `IMPORT_TELEMETRY_DEV=1`; use a separate test project for that override. No PostHog project or dashboard is provisioned by this code.

Events follow Studio's telemetry naming and typed interfaces in `src/telemetry/events.ts`. The importer has its own `useTrack` adapter and same-origin capture endpoint because Studio's adapter depends on dashboard authentication and routing. The endpoint sends only validated properties through the [PostHog capture API](https://posthog.com/docs/api/capture); it does not load browser autocapture, session replay, or error recording.

The app uses a separate random, HttpOnly analytics cookie, valid for 30 days, to join pageviews, actions, and worker outcomes. It never identifies Supabase accounts or sends project references, organization names, IP addresses, referrers, URL queries, filenames, backup contents, connection strings, SQL, prompts, or raw errors. Person-profile processing and GeoIP enrichment are disabled. Consent is managed by the host site, so this app does not add its own banner or gate capture on Do Not Track or Global Privacy Control. No analytics cookie is created while PostHog is not configured.

The private service schema adds a nullable `browser_jobs.telemetry_id` column on its next initialization check. No destination schema changes are needed. Worker events use the saved anonymous identity, so progress and outcomes remain measurable after the browser closes. Jobs created before tracking is enabled have no analytics identity and are not retrospectively identified.

Suggested PostHog insights (filter all of them by `app = instant-import`):

| Question                              | Events / breakdown                                                                                                                                                                                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How many visitors?                    | Unique `distinct_id` on `$pageview`, daily/weekly; anonymous browsers, not known people                                                                                                                                                                        |
| Where do people drop out?             | Funnel: `$pageview` → `instant_import_connection_clicked` (`connectionAction = connect`) → `instant_import_connection_completed` → `instant_import_backup_added` → `instant_import_submitted` → `instant_import_upload_completed` → `instant_import_completed` |
| Where do imports get to?              | `instant_import_stage_updated`, broken down by `importStage`; count distinct `jobId`                                                                                                                                                                           |
| How long do imports take?             | `elapsedMs` on `instant_import_completed`, with percentiles                                                                                                                                                                                                    |
| What fails or gets canceled?          | `instant_import_action_failed` by `importAction`; `instant_import_connection_failed` by `connectionResult`; `instant_import_failed` / `instant_import_closed` by `importStage`                                                                                 |
| Do users finish the handoff?          | `instant_import_handoff_opened`, `instant_import_handoff_copied`, and `instant_import_destination_clicked`, broken down by `handoffType`                                                                                                                       |
| Do large backups convert differently? | `fileCount` / `totalBytes` on `instant_import_submitted`, with `importMode` distinguishing resumes                                                                                                                                                             |

Upload completion is emitted after the server freezes the backup. Stages and terminal outcomes come from committed worker transitions, never from page renders or repeated progress polls. Stable event UUIDs deduplicate repeated outcomes on Workflow retries. Repeated explicit clicks and submissions are separate attempts; use unique visitors for the acquisition funnel and unique `jobId` for job outcomes. Folder selection and connection can happen in either order; omit or reorder those steps when exploring alternate paths.

Delivery is best effort with a 1.5-second timeout and no analytics-driven import retries. An analytics outage, blocked request, closed tab before browser delivery, or process crash can undercount events; the job database remains the source of truth. No per-record, per-file, or per-batch analytics events are emitted, so event volume stays bounded for multi-GB imports. Handoff events measure interaction with instructions, not whether the customer has completed their application migration.

### First-party usage log

Content blockers can drop the `/migrate/instantdb/api/telemetry` endpoint, and PostHog can be unconfigured or unavailable. As a backup, the app also appends events to `public.usage_events` in the private service project. It is on by default in every environment (rows carry `environment` from `VERCEL_ENV`, so filter by `environment = 'production'`); set `IMPORT_USAGE_LOG=0` to disable it. It is created by `supabase/migrations`, is insert-only from the server, has row level security enabled with no policies, and is revoked from `anon` and `authenticated`, so the Data API cannot reach it even though it is in `public`. Only the service connection or the dashboard can read it.

It records no identifier for a person or browser: no analytics cookie, session, IP address, user agent, referrer, or URL. Browser events use the same validated payloads as PostHog and arrive through a same-origin Server Action. Server events add the destination project ref (on job creation and inherited by that job's later rows), backup file counts and bytes at upload completion, stage, elapsed time, fixed failure codes, and on completion the verified and source totals and permission summary counts from `verification.json`. Rows have no foreign key, so they outlive job cleanup. Stable IDs deduplicate Workflow retries.

| Column        | Contents                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `event`       | Event name, matching the PostHog event plus `instant_import_job_created` and `instant_import_preflight_failed` |
| `job_id`      | Import job, for server events                                                                                  |
| `target_ref`  | Destination project ref, when known                                                                            |
| `environment` | `production`, `preview`, or `development`                                                                      |
| `properties`  | Validated counts and enums                                                                                     |

Successful-import cleanup applies to jobs that reach cleanup on this version. It does not retroactively purge completed jobs or set an expiry for abandoned uploads. Deletion removes live Storage objects and database rows; provider-managed database backups follow the service project’s own retention policy. Signed upload capabilities are path-scoped and short-lived; they never grant read access. Do not add client Storage policies to the private service project.
