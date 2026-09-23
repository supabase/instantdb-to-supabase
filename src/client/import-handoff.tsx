'use client'

import { ArrowUpRight, Check } from 'lucide-react'
import pluralize from 'pluralize'
import { useEffect, useState } from 'react'
import {
  Button,
  Card,
  CardContent,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from 'ui'

import type { Handoff, HandoffItem, HandoffRule } from '../import/handoff'
import { useTrack } from '../telemetry/client'
import { Code, CopyText, Disclosure } from './primitives'
import { api } from './upload'

const policyExplanations: Record<string, string> = {
  import_view: 'view becomes SELECT. USING decides which existing rows a user can read.',
  import_create: 'create becomes INSERT. WITH CHECK decides whether the new row is allowed.',
  import_update:
    'update becomes UPDATE. USING checks the existing row; WITH CHECK checks the resulting row.',
  import_delete: 'delete becomes DELETE. USING decides which existing rows a user can delete.',
}
const number = new Intl.NumberFormat('en-US')
function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** unit).toFixed(1)} ${['B', 'KiB', 'MiB', 'GiB'][unit]}`
}

function ConvertedRule({
  rule,
  jobId,
  explainRls,
}: {
  rule: Handoff['convertedRules'][number]
  jobId: string
  explainRls: boolean
}) {
  const track = useTrack()
  const [detail, setDetail] = useState<HandoffRule>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  async function load() {
    setLoading(true)
    setError(false)
    try {
      setDetail(await api<HandoffRule>(`/${jobId}/handoff?rule=${encodeURIComponent(rule.id)}`))
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }
  return (
    <Disclosure
      variant="row"
      title={rule.title}
      meta={rule.target}
      description={rule.review ? 'Applied · review access below' : undefined}
      onOpen={() => {
        track('instant_import_handoff_opened', { handoffType: 'policySql' })
        if (!detail && !loading) void load()
      }}
    >
      <div className="space-y-3 px-4 pb-4 pl-10 text-xs leading-5 text-foreground-light">
        {rule.review && (
          <p>{rule.review} Use the review prompt under Policies and relationships.</p>
        )}
        <p>
          {rule.policyName ? (
            <>
              {explainRls &&
                'Row-level security is the Postgres equivalent of InstantDB permissions: a policy is a condition every row must pass before a user can read or change it. '}
              Policy <code>{rule.policyName}</code> enforces this rule on <code>{rule.target}</code>
              .
            </>
          ) : (
            <>
              This operation stays closed. No access policy or grant was added, so this deny rule
              does not appear as a separate policy in Studio.
            </>
          )}
        </p>
        {loading && <p role="status">Loading source rule...</p>}
        {error && (
          <div className="space-y-2">
            <p role="alert">Could not load this rule. Try again.</p>
            <Button variant="default" onClick={() => void load()}>
              Retry rule
            </Button>
          </div>
        )}
        {detail && (
          <div className="space-y-4">
            {detail.suggestion && <p>{detail.suggestion}</p>}
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-foreground">
                InstantDB rule <code className="font-normal">{detail.source}</code>
              </h4>
              <Code
                label={`Source rule for ${rule.title}`}
                language={typeof detail.expression === 'string' ? 'js' : 'json'}
                value={
                  typeof detail.expression === 'string'
                    ? detail.expression
                    : JSON.stringify(detail.expression, null, 2)
                }
              />
              {Object.keys(detail.bindings).length > 0 && (
                <>
                  <p>Referenced bindings</p>
                  <Code
                    label={`Bindings for ${rule.title}`}
                    language="json"
                    value={JSON.stringify(detail.bindings, null, 2)}
                  />
                </>
              )}
            </div>
            {rule.policyName &&
              (detail.sql ? (
                <div className="space-y-2">
                  <h4 className="text-xs font-medium text-foreground">Supabase policy</h4>
                  <p>{policyExplanations[rule.policyName]}</p>
                  <Code
                    label={`Applied SQL for ${rule.title}`}
                    language="sql"
                    value={detail.sql.policy}
                  />
                  <Disclosure variant="card" title="Table grants" className="bg-transparent">
                    <div className="space-y-2 px-4 py-3">
                      <p>
                        <code>GRANT</code> lets a role use the table at all; the policy above then
                        limits which rows it can touch. <code>auth.uid()</code> is the signed-in
                        user, the same identity InstantDB exposes as <code>auth.id</code>.
                      </p>
                      <Code
                        label={`Supporting SQL for ${rule.title}`}
                        language="sql"
                        value={detail.sql.supporting}
                      />
                    </div>
                  </Disclosure>
                  <CopyText
                    text={detail.sql.all}
                    label="Copy policy SQL"
                    onCopied={() =>
                      track('instant_import_handoff_copied', { handoffType: 'policySql' })
                    }
                  />
                  <p>
                    This SQL matches what was saved at import. Fetch the migrations below for the
                    complete set, including the statement that enabled row-level security.
                  </p>
                </div>
              ) : (
                <p>
                  The applied SQL could not be matched to this import’s saved migration. Fetch the
                  recorded migrations below to inspect the original SQL.
                </p>
              ))}
          </div>
        )}
      </div>
    </Disclosure>
  )
}

function PromptItem({ item, jobId }: { item: HandoffItem; jobId: string }) {
  const track = useTrack()
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  async function load() {
    setLoading(true)
    setError('')
    try {
      setPrompt(
        (await api<{ prompt: string }>(`/${jobId}/handoff?item=${encodeURIComponent(item.id)}`))
          .prompt
      )
    } catch {
      setError('Could not load this prompt. Try again.')
    } finally {
      setLoading(false)
    }
  }
  return (
    <Disclosure
      variant="row"
      title={item.title}
      onOpen={() => {
        track('instant_import_handoff_opened', { handoffType: item.kind })
        if (!prompt && !loading) void load()
      }}
    >
      <div className="space-y-3 px-4 pb-4 pl-10">
        <p className="text-xs leading-5 text-foreground-light">{item.reason}</p>
        {loading && (
          <p role="status" className="text-xs text-foreground-light">
            Preparing prompt...
          </p>
        )}
        {error && (
          <div className="space-y-2">
            <p role="alert" className="text-xs text-foreground-light">
              {error}
            </p>
            <Button variant="default" onClick={() => void load()}>
              Retry prompt
            </Button>
          </div>
        )}
        {prompt && (
          <>
            <CopyText
              text={prompt}
              label="Copy agent prompt"
              onCopied={() => track('instant_import_handoff_copied', { handoffType: item.kind })}
            />
            <Code label={`Agent prompt for ${item.title}`} language="markdown" value={prompt} />
          </>
        )}
      </div>
    </Disclosure>
  )
}

function linkFor(handoff: Handoff, label: string) {
  return handoff.links.find((link) => link.label === label)?.href
}
function Destination({ href, children }: { href?: string; children: string }) {
  const track = useTrack()
  const handoffType = (
    {
      'Table Editor': 'tables',
      Authentication: 'auth',
      Storage: 'storage',
      'Database policies': 'policies',
      'Database migrations': 'migrations',
    } as const
  )[
    children as
      | 'Table Editor'
      | 'Authentication'
      | 'Storage'
      | 'Database policies'
      | 'Database migrations'
  ]
  if (!href) return <>{children}</>
  return (
    <a
      href={href}
      onClick={() => {
        if (handoffType) track('instant_import_destination_clicked', { handoffType })
      }}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-foreground underline underline-offset-4 hover:text-brand-link"
    >
      {children}
      <ArrowUpRight size={12} aria-hidden />
    </a>
  )
}

export function ImportHandoff({ jobId }: { jobId: string }) {
  const track = useTrack()
  const [handoff, setHandoff] = useState<Handoff>()
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setError('')
    void api<Handoff>(`/${jobId}/handoff`)
      .then((result) => {
        if (active) setHandoff(result)
      })
      .catch(() => {
        if (active) setError('Could not load the next steps. Try again.')
      })
    return () => {
      active = false
    }
  }, [jobId, attempt])
  if (error)
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-foreground-light">
          {error}
        </p>
        <Button variant="default" onClick={() => setAttempt((a) => a + 1)}>
          Retry next steps
        </Button>
      </div>
    )
  if (!handoff)
    return (
      <p role="status" className="text-sm text-foreground-light">
        Loading next steps...
      </p>
    )
  const { verified } = handoff
  const metrics = [
    { label: pluralize('Table', verified.namespaces), value: verified.namespaces },
    { label: pluralize('Record', verified.rows), value: verified.rows },
    { label: pluralize('Relationship', verified.edges), value: verified.edges },
    {
      label: pluralize('File', verified.files),
      value: verified.files,
      detail: verified.files ? formatBytes(verified.bytes) : undefined,
    },
  ]
  const mapping = [
    ['Namespaces', 'Tables in the public schema', 'Table Editor', linkFor(handoff, 'Open tables')],
    [
      'Links',
      'Foreign keys, or junction tables for many-to-many links',
      'Table Editor',
      linkFor(handoff, 'Open tables'),
    ],
    ['$users', 'Auth users', 'Authentication', linkFor(handoff, 'Open Auth')],
    ['$files', 'Storage objects in a private bucket', 'Storage', linkFor(handoff, 'Open Storage')],
    [
      'Permissions',
      'Row-level security policies',
      'Database policies',
      linkFor(handoff, 'Open RLS policies'),
    ],
    [
      'Schema',
      'SQL migrations recorded in the project',
      'Database migrations',
      linkFor(handoff, 'Open migrations'),
    ],
  ] as const
  let explainedRls = false
  return (
    <div className="space-y-8">
      <Card>
        <CardContent className="space-y-5 py-5">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Check size={16} className="text-brand" aria-hidden />
            Imported automatically
          </h2>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {metrics.map((metric) => (
              <div key={metric.label} className="rounded-md border bg-surface-200/60 px-4 py-3">
                <dt className="text-xs text-foreground-light">{metric.label}</dt>
                <dd className="mt-1 flex items-baseline gap-2">
                  <span className="text-2xl font-medium tabular-nums text-foreground">
                    {number.format(metric.value)}
                  </span>
                  {metric.detail && (
                    <span className="text-xs text-foreground-lighter">{metric.detail}</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-sm leading-6 text-foreground-light">
            Every record and link was verified against the backup after import. Schema changes are
            recorded as migrations in your project.
            {handoff.backupDeleted &&
              ' The uploaded backup and staged records have been deleted from the importer. Keep your local backup for the remaining setup steps.'}
          </p>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>InstantDB</TableHead>
                  <TableHead>Supabase</TableHead>
                  <TableHead>Where to find it</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mapping.map(([source, target, place, href]) => (
                  <TableRow key={source} className="hover:bg-transparent">
                    <TableCell className="py-2.5 font-mono text-xs">{source}</TableCell>
                    <TableCell className="py-2.5 text-xs">{target}</TableCell>
                    <TableCell className="py-2.5 text-xs">
                      <Destination href={href}>{place}</Destination>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="space-y-3">
            <p className="text-sm leading-6 text-foreground-light">
              {handoff.permissionsApplied
                ? `${pluralize('access policy', handoff.allowed, true)} applied · ${pluralize('deny rule', handoff.denied, true)} preserved. These rules could be translated without changing their meaning.`
                : 'This earlier import has unapplied security rules. Start with the security prompt below.'}
            </p>
            {handoff.permissionsApplied &&
              (['allow', 'deny'] as const).map((effect) => {
                const rules = handoff.convertedRules.filter((rule) => rule.effect === effect)
                return (
                  rules.length > 0 && (
                    <Disclosure
                      key={effect}
                      title={`${effect === 'allow' ? 'Applied access policies' : 'Preserved deny rules'} · ${rules.length}`}
                    >
                      <div className="max-h-[32rem] overflow-y-auto">
                        {rules.map((rule) => {
                          const explainRls = effect === 'allow' && !explainedRls
                          if (explainRls) explainedRls = true
                          return (
                            <ConvertedRule
                              key={rule.id}
                              rule={rule}
                              jobId={jobId}
                              explainRls={explainRls}
                            />
                          )
                        })}
                      </div>
                    </Disclosure>
                  )
                )
              })}
          </div>
        </CardContent>
      </Card>
      <div className="space-y-2">
        <h2 className="text-sm font-medium">Still needs your attention</h2>
        <p className="text-sm leading-6 text-foreground-light">
          The database import is complete. Getting your application running on it still requires
          code changes, service configuration, and decisions about rules that could not be
          translated safely. The prompts below give your coding agent the relevant source context
          for each task.
        </p>
      </div>
      <Card>
        <CardContent className="space-y-4 py-5">
          <h3 className="text-sm font-medium">1. Fetch migrations locally</h3>
          <p className="text-sm leading-6 text-foreground-light">
            Migrations are SQL files that describe your schema. Fetch them so your agent can build
            on the imported schema. Run these commands in your application directory. If it has no{' '}
            <code>supabase/config.toml</code>, run <code>supabase init</code> first.
          </p>
          <CopyText
            text={handoff.commands}
            label="Copy CLI commands"
            onCopied={() => track('instant_import_handoff_copied', { handoffType: 'cli' })}
          />
          <Code label="Supabase CLI commands" language="bash" value={handoff.commands} />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-4 py-5">
          <h3 className="text-sm font-medium">2. Finish with your coding agent</h3>
          <p className="text-sm leading-6 text-foreground-light">
            Run each prompt in that same directory. Review and test the new local migrations before
            running <code>supabase db push</code>.
          </p>
          {(['setup', 'policy'] as const).map((kind) => {
            const items = handoff.items.filter((item) => item.kind === kind)
            return (
              items.length > 0 && (
                <Disclosure
                  key={kind}
                  title={`${kind === 'policy' ? 'Policies and relationships' : 'Application setup'} · ${items.length}`}
                  description={
                    kind === 'setup'
                      ? 'Importing data does not rewrite your application or configure external services. Complete these tasks to connect your code, sign-in, and integrations to Supabase.'
                      : 'Some rules depend on field visibility, graph operations, or Auth and Storage behavior that row policies alone cannot reproduce. No access was granted for unconverted operations; implement and test the intended behavior before enabling it.'
                  }
                >
                  <div className="max-h-[32rem] overflow-y-auto">
                    {items.map((item) => (
                      <PromptItem key={item.id} item={item} jobId={jobId} />
                    ))}
                  </div>
                </Disclosure>
              )
            )
          })}
        </CardContent>
      </Card>
    </div>
  )
}
