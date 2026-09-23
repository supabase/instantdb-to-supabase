import { z } from 'zod'

export const connectionSchema = z.object({
  databaseRole: z.literal('postgres').optional(),
  databaseExpiresAt: z.number().int().positive().safe().optional(),
  databaseUrl: z.string().trim().min(1, 'Enter a Postgres connection string'),
  supabaseUrl: z.string().trim().url('Enter the project URL'),
  serviceRoleKey: z.string().trim().min(1, 'Enter a secret or service-role key'),
})
export type Connection = z.infer<typeof connectionSchema>
export type ImportConnection = { mode: 'oauth'; projectRef: string }
export type SupabaseProject = { ref: string; name: string; status: string; region: string }
export const fileSchema = z.object({
  path: z.string().min(1).max(1024),
  size: z.number().int().nonnegative().safe(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
export type FileDescriptor = z.infer<typeof fileSchema>
export const phases = [
  { id: 'analyzing', label: 'Read backup' },
  { id: 'validating', label: 'Validate records' },
  { id: 'schema', label: 'Create tables' },
  { id: 'auth', label: 'Import accounts' },
  { id: 'files', label: 'Copy files' },
  { id: 'rows', label: 'Import records' },
  { id: 'links', label: 'Connect relationships' },
  { id: 'constraints', label: 'Apply constraints' },
  { id: 'verify_links', label: 'Verify relationships' },
  { id: 'verifying', label: 'Verify records' },
  { id: 'reports', label: 'Apply security and prepare handoff' },
  { id: 'cleanup', label: 'Remove temporary import data' },
] as const
export type Progress = {
  jobId: string
  runId?: string
  status: string
  phase: string | null
  revision: string | null
  retrying: boolean
  attempt: number
  startedAt: string | null
  cancelRequested: boolean
  uploadedFiles: number
  totalFiles: number
  artifacts: string[]
}
/** Run rotation can briefly return no step results; keep the last confirmed checkpoint. */
export function retainProgress(previous: Progress | undefined, next: Progress): Progress {
  if (
    previous?.jobId === next.jobId &&
    previous.revision &&
    /^\d+$/.test(previous.revision) &&
    next.status !== 'completed' &&
    (next.revision === null ||
      (/^\d+$/.test(next.revision) && BigInt(next.revision) < BigInt(previous.revision)))
  )
    return { ...next, phase: previous.phase, revision: previous.revision }
  return next
}
export function completedBatches(revision: string | null) {
  // Revision 1 freezes the uploaded backup; subsequent revisions commit an import batch.
  return revision && /^\d+$/.test(revision) && BigInt(revision) > 0n
    ? (BigInt(revision) - 1n).toLocaleString('en-US')
    : null
}
export function phaseState(phase: string | null, current: string, status: string) {
  if (status === 'completed') return 'completed'
  const active = phases.findIndex((p) => p.id === phase),
    index = phases.findIndex((p) => p.id === current)
  return active < 0
    ? 'pending'
    : index < active
      ? 'completed'
      : index === active
        ? 'active'
        : 'pending'
}
