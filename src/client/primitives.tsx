'use client'

import { Check, ChevronRight, Copy } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, cn } from 'ui'
import { CodeBlock, type CodeBlockLang } from 'ui-patterns/CodeBlock'

/** Collapsible section. Uses a native disclosure so the browser owns open state. */
export function Disclosure({
  title,
  meta,
  description,
  children,
  className,
  variant = 'card',
  onOpen,
}: {
  title: ReactNode
  meta?: ReactNode
  description?: ReactNode
  children: ReactNode
  className?: string
  variant?: 'card' | 'row'
  onOpen?: () => void
}) {
  return (
    <details
      className={cn(
        variant === 'card' ? 'rounded-md border bg-surface-100' : 'border-b last:border-b-0',
        className
      )}
      onToggle={(event) => {
        if (event.currentTarget.open) onOpen?.()
      }}
    >
      <summary className="flex cursor-pointer list-none items-start gap-2 px-4 py-3 text-sm focus-visible:outline-brand [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={14}
          className="mt-1 shrink-0 text-foreground-lighter transition-transform [details[open]>summary>&]:rotate-90"
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{title}</span>
            {meta && <span className="text-xs text-foreground-light">{meta}</span>}
          </span>
          {description && (
            <span className="mt-1 block text-xs font-normal leading-5 text-foreground-light">
              {description}
            </span>
          )}
        </span>
      </summary>
      <div className={cn(variant === 'card' && 'border-t')}>{children}</div>
    </details>
  )
}

/** Syntax-highlighted code sample with an accessible label. */
export function Code({
  value,
  language,
  label,
  className,
}: {
  value: string
  language: CodeBlockLang
  label: string
  className?: string
}) {
  return (
    <div aria-label={label} className={className}>
      <CodeBlock
        language={language}
        value={value}
        hideCopy
        hideLineNumbers
        wrapLongLines
        className="[&_code]:text-foreground text-xs"
      />
    </div>
  )
}

export function CopyText({
  text,
  label,
  onCopied,
}: {
  text: string
  label: string
  onCopied?: () => void
}) {
  const [state, setState] = useState<'ready' | 'copied' | 'failed'>('ready')
  const reset = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(reset.current), [])
  return (
    <div className="space-y-2">
      <Button
        variant="default"
        icon={state === 'copied' ? <Check size={14} /> : <Copy size={14} />}
        onClick={async () => {
          clearTimeout(reset.current)
          try {
            await navigator.clipboard.writeText(text)
            setState('copied')
            onCopied?.()
            reset.current = setTimeout(() => setState('ready'), 2000)
          } catch {
            setState('failed')
          }
        }}
      >
        {state === 'copied' ? 'Copied' : label}
      </Button>
      {state === 'failed' && (
        <p role="alert" className="text-xs text-foreground-light">
          Clipboard access is blocked. Select and copy the text below.
        </p>
      )}
    </div>
  )
}

export const migrationSteps = [
  {
    title: 'Connect your project',
    description:
      'Create a fresh, blank Supabase project, then authorize access to it. Your InstantDB app stays unchanged.',
  },
  {
    title: 'Upload your backup',
    description:
      'Extract your InstantDB backup and select the folder. Namespaces, records, links, accounts, and files are imported.',
  },
  {
    title: 'Finish in your codebase',
    description:
      'Pull the SQL migrations and use the generated agent prompts to point your app at Supabase.',
  },
] as const

/** Compact horizontal stepper shown once a migration is in progress. */
export function MigrationStepper({ current }: { current: 1 | 2 | 3 }) {
  return (
    <ol
      className="mb-8 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-0"
      aria-label="Migration steps"
    >
      {migrationSteps.map((step, index) => {
        const number = (index + 1) as 1 | 2 | 3
        const state = number < current ? 'done' : number === current ? 'current' : 'todo'
        return (
          <li
            key={step.title}
            className="flex flex-1 items-center gap-3 sm:gap-3"
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-xs',
                state === 'done' && 'border-brand bg-brand-200 text-brand',
                state === 'current' && 'border-foreground text-foreground',
                state === 'todo' && 'text-foreground-lighter'
              )}
              aria-hidden
            >
              {state === 'done' ? <Check size={12} /> : number}
            </span>
            <span
              className={cn(
                'text-sm',
                state === 'current' ? 'font-medium text-foreground' : 'text-foreground-light'
              )}
            >
              {step.title}
            </span>
            {index < migrationSteps.length - 1 && (
              <span aria-hidden className="mx-3 hidden h-px flex-1 bg-border sm:block" />
            )}
          </li>
        )
      })}
    </ol>
  )
}
