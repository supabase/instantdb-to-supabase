'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { ArrowRight, ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardFooter,
  Form,
  FormControl,
  FormField,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from 'ui'
import { Admonition } from 'ui-patterns/Admonition'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'
import {
  PageSection,
  PageSectionContent,
  PageSectionDescription,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'
import { z } from 'zod'

import { useTrack } from '../telemetry/client'
import type { ImportConnection, SupabaseProject } from './contracts'
import { requestJson, type RetryOptions } from './request'

type ConnectionState = {
  ready?: boolean
  configured: boolean
  connected: boolean
  projects: SupabaseProject[]
  error?: string
}
function oauthRequest<T>(path: string, method = 'GET', options?: RetryOptions): Promise<T> {
  return requestJson(`/api/supabase/${path}`, { method, cache: 'no-store' }, options)
}
export function useSupabaseConnection() {
  const track = useTrack()
  const [connection, setConnection] = useState<ConnectionState>({
    configured: false,
    connected: false,
    projects: [],
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retryNotice, setRetryNotice] = useState('')
  const [refreshVersion, setRefreshVersion] = useState(0)
  useEffect(() => {
    setLoading(true)
    setError('')
    let active = true
    const abort = new AbortController()
    const url = new URL(window.location.href),
      result = url.searchParams.get('supabase')
    if (result) {
      if (result !== 'connected')
        setError(
          result === 'denied'
            ? 'Supabase access was not authorized. Try connecting again and authorize access.'
            : 'The Supabase connection expired or could not be completed. Try connecting again.'
        )
      url.searchParams.delete('supabase')
      window.history.replaceState(null, '', url)
    }
    void oauthRequest<ConnectionState>('connection', 'GET', {
      signal: abort.signal,
      onRetry: (message) => {
        if (active) setRetryNotice(message)
      },
    })
      .then((value) => {
        if (active) {
          setConnection(value)
          if (value.error) setError(value.error)
        }
      })
      .catch((error) => {
        if (active)
          setError(error instanceof Error ? error.message : 'Could not load Supabase projects')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      abort.abort()
    }
  }, [refreshVersion])
  async function connect() {
    track('instant_import_connection_clicked', { connectionAction: 'connect' })
    setLoading(true)
    setError('')
    try {
      window.location.assign((await oauthRequest<{ url: string }>('connect', 'POST')).url)
    } catch (error) {
      track('instant_import_action_failed', { importAction: 'connect' })
      setError(error instanceof Error ? error.message : 'Could not connect to Supabase')
      setLoading(false)
    }
  }
  async function disconnect() {
    track('instant_import_connection_clicked', { connectionAction: 'disconnect' })
    setLoading(true)
    setError('')
    try {
      await oauthRequest('connection', 'DELETE')
      setConnection((previous) => ({
        ready: previous.ready,
        configured: true,
        connected: false,
        projects: [],
      }))
    } catch (error) {
      track('instant_import_action_failed', { importAction: 'disconnect' })
      setError(error instanceof Error ? error.message : 'Could not disconnect Supabase')
    } finally {
      setLoading(false)
    }
  }
  return {
    ...connection,
    loading,
    error,
    retryNotice,
    connect,
    disconnect,
    reload: () => {
      track('instant_import_connection_clicked', { connectionAction: 'refresh' })
      setRefreshVersion((value) => value + 1)
    },
  }
}
export function SupabaseConnectionPanel({
  connection,
  disabled,
}: {
  connection: ReturnType<typeof useSupabaseConnection>
  disabled: boolean
}) {
  return (
    <div className="mb-8 space-y-3">
      <Card>
        <CardContent className="flex flex-col gap-5 py-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm font-medium">
              Supabase account
              {connection.connected && <Badge variant="success">Connected</Badge>}
            </div>
            <p className="max-w-xl text-xs leading-5 text-foreground-light">
              {connection.connected
                ? 'Choose a fresh, blank project below to receive your backup.'
                : 'Connect your Supabase account, then choose a fresh, blank project for your InstantDB data.'}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant={connection.connected ? 'default' : 'primary'}
              size="medium"
              iconRight={connection.connected ? undefined : <ArrowRight size={16} />}
              disabled={disabled || connection.loading || !connection.configured}
              loading={connection.loading}
              onClick={() =>
                void (connection.connected ? connection.disconnect() : connection.connect())
              }
            >
              {connection.connected ? 'Disconnect' : 'Connect Supabase'}
            </Button>
          </div>
        </CardContent>
      </Card>
      {!connection.loading && !connection.configured && !connection.error && (
        <p role="status" className="text-xs text-foreground-light">
          Supabase OAuth is not configured for this deployment. Set the IMPORT_OAUTH_* environment
          variables to enable imports.
        </p>
      )}
      {connection.retryNotice && (
        <p role="status" className="text-sm text-foreground-light">
          {connection.retryNotice}
        </p>
      )}
      {connection.error && (
        <Admonition
          type="destructive"
          layout="responsive"
          title="Supabase connection failed"
          description={connection.error}
          actions={
            <Button variant="default" disabled={connection.loading} onClick={connection.reload}>
              Retry connection
            </Button>
          }
        />
      )}
    </div>
  )
}
const schema = z.object({
  projectRef: z.string().regex(/^[a-z0-9]{20}$/, 'Choose a project'),
})
const defaults = { projectRef: '' }
const unavailableReasons: Record<string, string> = {
  INACTIVE: 'paused',
  PAUSING: 'pausing',
  COMING_UP: 'starting',
  RESTORING: 'restoring',
  RESTARTING: 'restarting',
  UPGRADING: 'upgrading',
  GOING_DOWN: 'shutting down',
  REMOVED: 'deleted',
}
export function OAuthDestinationForm({
  projects,
  busy,
  canSubmit,
  onSubmit,
  refreshing,
  onRefresh,
}: {
  projects: SupabaseProject[]
  busy: boolean
  canSubmit: boolean
  onSubmit: (target: ImportConnection) => Promise<void>
  refreshing: boolean
  onRefresh: () => void
}) {
  const track = useTrack()
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: defaults,
  })
  const { isSubmitting } = form.formState
  return (
    <PageSection className="gap-4 pt-0 last:pb-0">
      <PageSectionMeta>
        <PageSectionSummary>
          <PageSectionTitle className="text-base">Destination project</PageSectionTitle>
          <PageSectionDescription className="text-sm">
            Use a new, empty Supabase project. It must have no application tables, Auth users, or
            Storage buckets.
          </PageSectionDescription>
        </PageSectionSummary>
      </PageSectionMeta>
      <PageSectionContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((values) => onSubmit({ mode: 'oauth', ...values }))}>
            <Card>
              <CardContent className="py-6">
                <FormField
                  control={form.control}
                  name="projectRef"
                  render={({ field }) => (
                    <FormItemLayout
                      layout="flex-row-reverse"
                      label="Project"
                      description={
                        projects.length
                          ? 'Only active, healthy projects can receive an import. Projects you create or authorize later appear after a refresh.'
                          : 'No projects are available. Create a project, then refresh this list. If it is still missing, reconnect Supabase and authorize access to it.'
                      }
                    >
                      <div className="space-y-2">
                        <Select
                          value={field.value}
                          onValueChange={(value) => {
                            field.onChange(value)
                            track('instant_import_destination_updated', {
                              connectionAction: 'selectProject',
                            })
                          }}
                          disabled={busy}
                        >
                          <FormControl>
                            <SelectTrigger onBlur={field.onBlur} ref={field.ref}>
                              <SelectValue placeholder="Choose a blank project" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {projects.map((project) => {
                              const healthy = project.status === 'ACTIVE_HEALTHY'
                              const reason = unavailableReasons[project.status] ?? 'unavailable'
                              return (
                                <SelectItem
                                  key={project.ref}
                                  value={project.ref}
                                  disabled={!healthy}
                                >
                                  <span className="flex min-w-0 items-baseline gap-2">
                                    <span className="truncate">{project.name}</span>
                                    <span className="truncate text-xs text-foreground-lighter">
                                      {project.ref} · {project.region}
                                    </span>
                                    {!healthy && (
                                      <span className="shrink-0 text-xs text-foreground-lighter">
                                        · Not available: {reason}
                                      </span>
                                    )}
                                  </span>
                                </SelectItem>
                              )
                            })}
                          </SelectContent>
                        </Select>
                        <div className="flex items-center justify-between gap-3">
                          <a
                            href="https://supabase.com/dashboard/new/_"
                            onClick={() =>
                              track('instant_import_connection_clicked', {
                                connectionAction: 'createProject',
                              })
                            }
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-foreground-light transition-colors hover:text-foreground focus-visible:outline-brand"
                          >
                            Create a new project
                            <ExternalLink size={12} aria-hidden />
                          </a>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                type="button"
                                variant="text"
                                size="tiny"
                                aria-label="Refresh projects"
                                disabled={busy || refreshing}
                                loading={refreshing}
                                icon={<RefreshCw />}
                                onClick={onRefresh}
                              />
                            </TooltipTrigger>
                            <TooltipContent side="bottom">Refresh projects</TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                    </FormItemLayout>
                  )}
                />
              </CardContent>
              <CardFooter className="flex-col items-start gap-4 bg-surface-200 sm:flex-row sm:items-center sm:justify-between">
                <p className="flex max-w-md items-start gap-2 text-xs leading-5 text-foreground-lighter">
                  <ShieldCheck size={15} className="mt-0.5 shrink-0" aria-hidden />
                  The importer checks that the project is empty before writing data. Existing data
                  is never merged or overwritten.
                </p>
                <Button
                  type="submit"
                  disabled={!canSubmit || busy || !projects.length}
                  loading={isSubmitting}
                  iconRight={<ArrowRight size={14} />}
                >
                  Start import
                </Button>
              </CardFooter>
            </Card>
          </form>
        </Form>
      </PageSectionContent>
    </PageSection>
  )
}
