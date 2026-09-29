'use client'

import { Admonition } from 'ui-patterns/Admonition'

import { Code, CopyText, Disclosure } from './primitives'

const troubleshootingPrompt = `Help me troubleshoot my migration from InstantDB to Supabase.

I am using the importer at https://supabase.com/migrate/instantdb. Its source and documentation are at https://github.com/supabase/instantdb-to-supabase.

InstantDB has blocked new sign-ups, so the team could not fully test the migration flow. Do not assume that sign-ups caused my error or that a completed import means my application is ready.

1. Ask which step failed, what I expected, and what happened. Ask for a redacted error message, whether I have an extracted backup, and whether the destination already contains a partial import. Never ask me to paste credentials, tokens, connection strings, private records, or file contents into chat or logs.
2. Read the importer's current README and relevant source before suggesting commands. The input is an extracted folder containing config.json, entities/*.jsonl, and files/*, not a ZIP. Work from my existing backup; do not require a new InstantDB account or suggest bypassing sign-up restrictions. If I cannot obtain a backup through supported access, explain the blocker.
3. Start with read-only checks and distinguish connection, backup, upload, restore, and application setup issues. Preserve the original backup and source app. Do not reset or delete destination data, overwrite files, or start a new import over a partial one. Check the documented resume path for the existing job first, and explain any proposed writes before asking for approval.
4. Suggest the smallest supported fix. If a local importer change or CLI workaround is needed, check its documented limits, show the change, and test with synthetic data or a disposable local project first. Keep secrets in local environment variables and private data out of source control and logs. Do not disable row-level security or broaden permissions to make the migration pass; leave ambiguous rules closed.
5. Verify records, relationships, Auth, Storage, and permissions as relevant to the failure. After a completed import, use the generated handoff prompts to finish application setup. Report what was verified, what remains untested, and any remaining blockers without claiming full behavioral equivalence.

Start by asking for the missing details needed to diagnose my issue.`

export function ImportWarning() {
  return (
    <Admonition
      type="warning"
      className="mb-6"
      title="This migration flow may not work for all users"
      description="InstantDB has blocked new sign-ups, so we could not fully test the migration flow. If something goes wrong, use the prompt below to troubleshoot with your coding agent."
    >
      <Disclosure title="Troubleshoot with a coding agent" className="mt-3">
        <div className="space-y-3 p-4">
          <p className="text-sm text-foreground-light">
            Copy this prompt into your coding agent in your app’s codebase. Remove credentials and
            private data from any error messages you share.
          </p>
          <CopyText text={troubleshootingPrompt} label="Copy troubleshooting prompt" />
          <Code
            label="Migration troubleshooting prompt"
            language="markdown"
            value={troubleshootingPrompt}
          />
        </div>
      </Disclosure>
    </Admonition>
  )
}
