'use client'

import { Check, FolderOpen, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Badge, Button, Card, CardContent, CardHeader } from 'ui'
import { Admonition } from 'ui-patterns/Admonition'
import { PageContainer } from 'ui-patterns/PageContainer'
import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
} from 'ui-patterns/PageHeader'
import {
  PageSection,
  PageSectionContent,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'

import { basePath } from '../base-path'
import { useTrack } from '../telemetry/client'
import {
  completedBatches,
  phases,
  phaseState,
  retainProgress,
  type ImportConnection,
  type Progress,
} from './contracts'
import { ImportHandoff } from './import-handoff'
import { ImportShell } from './import-shell'
import { ImportWarning } from './import-warning'
import { MigrationStepper, migrationSteps } from './primitives'
import {
  OAuthDestinationForm,
  SupabaseConnectionPanel,
  useSupabaseConnection,
} from './supabase-connection'
import { api, selectFiles, uploadBackup, type SelectedFile } from './upload'

const terminalStatuses = ['completed', 'cancelled', 'blocked', 'failed']
/** What each import phase means in InstantDB terms. Keys match `phases` ids. */
const phaseDescriptions: Record<(typeof phases)[number]['id'], string> = {
  analyzing: 'Reads config.json and your entity files',
  validating: 'Checks every record, link, and file before anything is written',
  schema: 'Each namespace becomes a Postgres table',
  auth: '$users become Supabase Auth accounts',
  files: '$files become objects in Supabase Storage',
  rows: 'Entity records become table rows',
  links: 'Links become foreign keys between tables',
  constraints: 'Required and unique attributes become database constraints',
  verify_links: 'Confirms every link was restored in both directions',
  verifying: 'Compares the imported rows with your backup',
  reports: 'Permission rules become row-level security policies',
  cleanup: 'Deletes the uploaded backup and temporary import data',
}
function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}
function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** unit).toFixed(1)} ${['B', 'KiB', 'MiB', 'GiB'][unit]}`
}
function runStatus(progress: Progress | undefined, finished: boolean) {
  const status = progress?.status
  if (progress?.cancelRequested && !finished)
    return { label: 'Canceling after this batch', variant: 'warning' as const }
  if (progress?.retrying)
    return { label: `Retrying · attempt ${progress.attempt}`, variant: 'warning' as const }
  switch (status) {
    case 'pending':
      return { label: 'Queued', variant: 'default' as const }
    case 'running':
      return { label: 'Running', variant: 'success' as const }
    case 'completed':
      return { label: 'Complete', variant: 'success' as const }
    case 'failed':
      return { label: 'Paused after an error', variant: 'destructive' as const }
    case 'cancelled':
      return { label: 'Canceled', variant: 'warning' as const }
    case 'blocked':
      return { label: 'Needs attention', variant: 'warning' as const }
    default:
      return { label: 'Starting', variant: 'default' as const }
  }
}

export function ImportPage() {
  const track = useTrack()
  const supabase = useSupabaseConnection()
  const ready = supabase.ready === true
  const [files, setFiles] = useState<SelectedFile[]>([])
  const [jobId, setJobId] = useState<string>()
  const [progress, setProgress] = useState<Progress>()
  const [error, setError] = useState('')
  const [retryNotice, setRetryNotice] = useState('')
  const [pollError, setPollError] = useState('')
  const [busy, setBusy] = useState(false)
  const [transferring, setTransferring] = useState(false)
  const [pollAttempt, setPollAttempt] = useState(0)
  const [transfer, setTransfer] = useState<{
    file: string
    bytes: number
    total: number
    hashing: boolean
  }>()
  const controller = useRef<AbortController | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const id = new URL(window.location.href).searchParams.get('job')
    if (id && /^[a-f\d-]{36}$/i.test(id)) setJobId(id)
    return () => controller.current?.abort()
  }, [])
  useEffect(() => {
    if (!jobId) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      // Each poll opens a database connection, so stop once the job can no longer change.
      let done = false
      try {
        const value = await api<Progress>(`/${jobId}`)
        if (active) {
          setProgress((previous) => retainProgress(previous, value))
          setPollError('')
        }
        done = terminalStatuses.includes(value.status)
      } catch (e) {
        if (active) setPollError(e instanceof Error ? e.message : 'Could not refresh progress')
      }
      if (active && !done) timer = setTimeout(poll, 2000)
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [jobId, pollAttempt])

  function rememberJob(id: string) {
    setJobId(id)
    const url = new URL(window.location.href)
    url.searchParams.set('job', id)
    window.history.replaceState(null, '', url)
  }
  async function upload(target?: ImportConnection) {
    if (!files.length) {
      setError('Choose your extracted backup folder first')
      return
    }
    track('instant_import_submitted', {
      fileCount: files.length,
      totalBytes: files.reduce((total, file) => total + file.file.size, 0),
      importMode: jobId ? 'resume' : 'new',
    })
    setError('')
    setBusy(true)
    setTransferring(true)
    const abort = new AbortController()
    controller.current = abort
    try {
      await uploadBackup({
        files,
        target,
        jobId,
        signal: abort.signal,
        onJob: rememberJob,
        onProgress: setTransfer,
        onRetry: setRetryNotice,
      })
    } catch (e) {
      if (!isAbortError(e)) track('instant_import_action_failed', { importAction: 'upload' })
      // Pausing aborts the in-flight request; that is a deliberate stop, not a failure.
      setError(
        isAbortError(e)
          ? ''
          : e instanceof Error
            ? e.message
            : 'The upload did not finish. Try again.'
      )
    } finally {
      setBusy(false)
      setTransferring(false)
      controller.current = null
    }
  }
  async function action(method: 'POST' | 'DELETE') {
    track('instant_import_control_clicked', {
      importAction: method === 'POST' ? 'retry' : 'cancel',
    })
    setError('')
    setBusy(true)
    try {
      await api(`/${jobId}${method === 'POST' ? '/start' : ''}`, {}, method)
      setPollAttempt((attempt) => attempt + 1)
    } catch (e) {
      track('instant_import_action_failed', {
        importAction: method === 'POST' ? 'retry' : 'cancel',
      })
      setError(e instanceof Error ? e.message : 'The request did not finish')
    } finally {
      setBusy(false)
    }
  }
  const status = progress?.status
  const uploading = !jobId || !progress || status === 'uploading'
  const finished = terminalStatuses.includes(status ?? '')
  const total = files.reduce((sum, entry) => sum + entry.file.size, 0)
  const heading =
    status === 'completed'
      ? 'Import complete'
      : status === 'failed'
        ? 'Import paused after an error'
        : status === 'cancelled'
          ? 'Import canceled'
          : status === 'blocked'
            ? 'Import needs attention'
            : jobId
              ? 'Your import'
              : 'Migrate from InstantDB to Supabase'
  const step: 1 | 2 | 3 = status === 'completed' ? 3 : jobId || supabase.connected ? 2 : 1
  const showStepper = Boolean(jobId) || supabase.connected
  return (
    <ImportShell>
      <PageHeader size="default" className={jobId ? 'pb-8' : 'pb-10 pt-10 sm:pt-16'}>
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle
              className={
                jobId
                  ? undefined
                  : 'max-w-2xl text-4xl font-normal leading-tight tracking-tight sm:text-5xl'
              }
            >
              {jobId ? (
                heading
              ) : (
                <>
                  Migrate from InstantDB
                  <br />
                  to <span className="text-brand-link">Supabase.</span>
                </>
              )}
            </PageHeaderTitle>
            <PageHeaderDescription
              className={
                jobId ? 'mt-1 max-w-2xl text-sm leading-6' : 'mt-5 max-w-2xl text-base leading-7'
              }
            >
              {status === 'completed'
                ? 'Inspect your data, fetch migrations, and finish the remaining setup locally.'
                : jobId
                  ? 'You can close this tab after the upload finishes. Return to this URL in the same browser to check progress.'
                  : 'Each InstantDB namespace becomes a Postgres table, links become relationships between tables, $users become Supabase Auth accounts, and $files become Storage files. Every schema change is saved as a SQL migration you can keep in your codebase.'}
            </PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="default" className="pb-10">
        <ImportWarning />
        {showStepper && <MigrationStepper current={step} />}
        {!jobId && <SupabaseConnectionPanel connection={supabase} disabled={busy || !ready} />}
        {supabase.ready === false && (
          <Admonition
            type="warning"
            className="mb-6"
            title="Imports are not available on this deployment"
            description="The importer needs its private Storage and credential encryption configuration before it can accept imports."
          />
        )}
        {retryNotice && (
          <p role="status" className="mb-4 text-sm text-foreground-light">
            {retryNotice}
          </p>
        )}
        {(error || pollError) && (
          <Admonition
            type="destructive"
            className="mb-6"
            title={pollError && !error ? 'Progress could not be refreshed' : 'Import stopped'}
            description={error || pollError}
          />
        )}
        <div className="space-y-10">
          <div className="space-y-8">
            {uploading && (jobId || supabase.connected) && (
              <PageSection id="backup" className="gap-4 pt-0 last:pb-0">
                <PageSectionMeta>
                  <PageSectionSummary>
                    <PageSectionTitle className="text-base">Backup folder</PageSectionTitle>
                  </PageSectionSummary>
                </PageSectionMeta>
                <PageSectionContent>
                  <Card>
                    <CardContent className="space-y-4 py-6">
                      <input
                        ref={picker}
                        type="file"
                        aria-label="Backup folder"
                        multiple
                        {...{ webkitdirectory: '' }}
                        disabled={busy}
                        className="sr-only"
                        onChange={(event) => {
                          try {
                            const selected = selectFiles(Array.from(event.target.files ?? []))
                            setFiles(selected)
                            track('instant_import_backup_added', {
                              fileCount: selected.length,
                              totalBytes: selected.reduce(
                                (total, file) => total + file.file.size,
                                0
                              ),
                              importMode: jobId ? 'resume' : 'new',
                            })
                            setError('')
                          } catch (e) {
                            track('instant_import_action_failed', { importAction: 'folder' })
                            setFiles([])
                            setError(e instanceof Error ? e.message : 'Could not read the folder')
                          }
                        }}
                      />
                      <button
                        tabIndex={busy ? -1 : 0}
                        type="button"
                        disabled={busy}
                        onClick={() => picker.current?.click()}
                        className="flex w-full flex-col items-center gap-3 rounded-md border border-dashed bg-surface-200/50 px-4 py-8 text-center transition-colors hover:border-foreground-muted hover:bg-surface-200 focus-visible:outline-brand disabled:opacity-50"
                      >
                        <FolderOpen
                          size={28}
                          strokeWidth={1.25}
                          className="shrink-0 text-foreground-lighter"
                          aria-hidden
                        />
                        <span className="space-y-1">
                          <span className="block text-sm font-medium">
                            {files.length
                              ? files[0].file.webkitRelativePath.split('/')[0] || 'Backup selected'
                              : 'Choose an extracted backup folder'}
                          </span>
                          <span className="block text-xs text-foreground-light">
                            {files.length
                              ? `${files.length} files · ${formatBytes(total)} · Click to change`
                              : 'The folder contains config.json, an entities folder, and a files folder'}
                          </span>
                        </span>
                      </button>
                      <p className="text-xs leading-5 text-foreground-lighter">
                        Extract the backup before selecting it. Large files upload in resumable
                        chunks. Keep this tab open until the upload finishes.
                      </p>
                      {transfer && (
                        <div className="space-y-2" aria-live="polite">
                          <div className="flex justify-between gap-3 text-xs text-foreground-light">
                            <span className="truncate">
                              {transfer.hashing ? 'Checking' : 'Uploading'} {transfer.file}
                            </span>
                            <span className="shrink-0">
                              {formatBytes(transfer.bytes)} / {formatBytes(transfer.total)}
                            </span>
                          </div>
                          <progress
                            aria-label="Backup upload"
                            className="h-1 w-full accent-brand"
                            value={transfer.bytes}
                            max={transfer.total || 1}
                          />
                        </div>
                      )}
                      {(jobId || transferring) && (
                        <div className="flex items-center gap-3">
                          {jobId && (
                            <Button disabled={!files.length || busy} onClick={() => void upload()}>
                              Resume upload
                            </Button>
                          )}
                          {transferring && (
                            <Button
                              variant="default"
                              onClick={() => {
                                track('instant_import_control_clicked', { importAction: 'pause' })
                                controller.current?.abort()
                              }}
                            >
                              Pause upload
                            </Button>
                          )}
                          {jobId && (
                            <span className="text-xs text-foreground-lighter">
                              {progress?.uploadedFiles ?? 0} /{' '}
                              {progress?.totalFiles ?? files.length} files uploaded
                            </span>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </PageSectionContent>
              </PageSection>
            )}
            {!jobId && supabase.connected && (
              <OAuthDestinationForm
                refreshing={supabase.loading}
                onRefresh={supabase.reload}
                projects={supabase.projects}
                busy={busy}
                canSubmit={ready && files.length > 0}
                onSubmit={upload}
              />
            )}
            {jobId && !uploading && status !== 'completed' && (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between gap-4">
                    <h2 className="text-sm font-medium">Import progress</h2>
                    {(() => {
                      const run = runStatus(progress, finished)
                      return (
                        <Badge role="status" variant={run.variant}>
                          {run.label}
                        </Badge>
                      )
                    })()}
                  </div>
                </CardHeader>
                <CardContent className="p-6">
                  <p
                    role="status"
                    aria-live="polite"
                    className="mb-5 text-sm text-foreground-light"
                  >
                    {progress?.revision
                      ? `${completedBatches(progress.revision)} batches completed. Progress updates after each saved batch.`
                      : status === 'pending'
                        ? 'Waiting for an import worker to start.'
                        : 'Starting the first batch. Progress appears when it finishes.'}
                  </p>
                  <ol className="space-y-0">
                    {phases.map((phase, index) => {
                      const state = phaseState(
                        progress?.phase ?? null,
                        phase.id,
                        status ?? 'pending'
                      )
                      return (
                        <li
                          key={phase.id}
                          className="relative flex items-start gap-4 pb-5 last:pb-0"
                        >
                          {index < phases.length - 1 && (
                            <span aria-hidden className="absolute left-3 top-7 h-full border-l" />
                          )}
                          <span
                            className={`relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full border bg-surface-100 ${state === 'completed' ? 'border-brand bg-brand-200 text-brand' : state === 'active' ? 'border-brand text-brand' : 'text-foreground-muted'}`}
                          >
                            {state === 'completed' ? (
                              <Check size={13} />
                            ) : state === 'active' && !finished ? (
                              <LoaderCircle size={13} className="animate-spin" />
                            ) : (
                              <span className="text-xs">{index + 1}</span>
                            )}
                          </span>
                          <span className="min-w-0 flex-1 pt-0.5">
                            <span
                              className={`block text-sm ${state === 'pending' ? 'text-foreground-lighter' : 'text-foreground'}`}
                            >
                              {phase.label}
                            </span>
                            <span
                              className={`block text-xs leading-5 ${state === 'pending' ? 'text-foreground-muted' : 'text-foreground-light'}`}
                            >
                              {phaseDescriptions[phase.id]}
                            </span>
                          </span>
                          <span className="shrink-0 pt-1 text-xs text-foreground-lighter">
                            {state === 'completed'
                              ? 'Complete'
                              : state === 'active'
                                ? finished
                                  ? 'Stopped here'
                                  : 'In progress'
                                : ''}
                          </span>
                        </li>
                      )
                    })}
                  </ol>
                  {status === 'failed' && (
                    <div className="mt-6 space-y-3 border-t pt-5">
                      <p className="text-sm text-foreground-light">
                        The import stopped after retrying a batch. Retry to continue from the last
                        saved checkpoint. Nothing already imported is repeated.
                      </p>
                      <Button disabled={busy} onClick={() => void action('POST')}>
                        Retry import
                      </Button>
                    </div>
                  )}
                  {status === 'cancelled' && (
                    <p className="mt-6 border-t pt-5 text-sm text-foreground-light">
                      Batches that finished before the cancel stay in the destination project. Use a
                      blank project for a new import.
                    </p>
                  )}
                  {status === 'blocked' && (
                    <p className="mt-6 border-t pt-5 text-sm text-foreground-light">
                      The destination changed during the import, or another job now owns it. Start a
                      new import into a blank project.
                    </p>
                  )}
                </CardContent>
              </Card>
            )}
            {jobId && status === 'completed' && <ImportHandoff jobId={jobId} />}
            {jobId && (
              <div className="flex items-center justify-between">
                <a
                  className="text-xs text-foreground-light underline underline-offset-4"
                  href={basePath}
                >
                  Start another import
                </a>
                {!finished && (
                  <Button
                    variant="text"
                    disabled={busy || progress?.cancelRequested}
                    onClick={() => void action('DELETE')}
                  >
                    Cancel import
                  </Button>
                )}
              </div>
            )}
          </div>
          {!showStepper && (
            <section aria-labelledby="import-steps" className="border-t pt-8">
              <h2 id="import-steps" className="mb-6 text-base font-medium">
                Your migration in three steps
              </h2>
              <ol className="grid gap-8 sm:grid-cols-3">
                {migrationSteps.map((item, index) => (
                  <li key={item.title} className="space-y-3">
                    <span
                      className="flex h-7 w-7 items-center justify-center rounded-full border bg-surface-100 font-mono text-xs text-foreground-light"
                      aria-hidden
                    >
                      {index + 1}
                    </span>
                    <h3 className="text-sm font-medium">{item.title}</h3>
                    <p className="text-sm leading-6 text-foreground-light">{item.description}</p>
                  </li>
                ))}
              </ol>
            </section>
          )}
          {jobId && status !== 'completed' && (
            <aside className="space-y-5 border-t pt-6">
              <div className="grid gap-6 md:grid-cols-3">
                {[
                  [
                    'Schema and records',
                    'After the import, fetch the recorded migrations with the Supabase CLI to keep the schema in your codebase.',
                  ],
                  [
                    'Accounts and files',
                    'Users are imported without passwords and must sign in again. Files stay private in Storage.',
                  ],
                  [
                    'Access rules',
                    'Rules that translate directly are applied as row-level security policies. Agent prompts cover the rest.',
                  ],
                ].map(([title, description]) => (
                  <div key={title} className="space-y-1">
                    <h3 className="text-xs font-medium">{title}</h3>
                    <p className="text-xs leading-5 text-foreground-light">{description}</p>
                  </div>
                ))}
              </div>
              <p className="break-all font-mono text-xs text-foreground-muted">Import {jobId}</p>
            </aside>
          )}
        </div>
      </PageContainer>
    </ImportShell>
  )
}
