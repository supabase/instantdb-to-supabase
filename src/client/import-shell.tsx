'use client'

import { ArrowRight } from 'lucide-react'
import Image from 'next/image'
import type { ReactNode } from 'react'
import { TooltipProvider } from 'ui'
import { ThemeToggle } from 'ui-patterns/ThemeToggle'

import { basePath } from '../base-path'

export function ImportShell({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex min-h-screen flex-col bg-background">
        <a href="#main" className="sr-only focus:not-sr-only focus:m-6 focus:text-brand">
          Skip to import
        </a>
        <header className="border-b bg-surface-100/60">
          <div className="mx-auto flex h-12 max-w-5xl items-center justify-between px-6 xl:px-10">
            <a
              href={basePath}
              aria-label="InstantDB to Supabase migration home"
              className="flex items-center gap-2 text-sm font-medium tracking-tight text-foreground focus-visible:outline-brand"
            >
              <span>InstantDB</span>
              <ArrowRight size={14} className="text-foreground-lighter" aria-hidden />
              <Image
                src={`${basePath}/supabase-logo.svg`}
                alt=""
                width={18}
                height={20}
                className="h-5 w-[18px]"
                priority
              />
              <span>Supabase</span>
            </a>
            <ThemeToggle triggerClassName="rounded-md border bg-surface-100 hover:bg-surface-200 focus-visible:outline-brand" />
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-5xl flex-1 pb-8">
          {children}
        </main>
        <footer className="border-t">
          <p className="mx-auto max-w-5xl px-6 py-5 text-xs text-foreground-lighter xl:px-10">
            Imports write only to the Supabase project you choose. Your InstantDB app and backup
            stay unchanged.
          </p>
        </footer>
      </div>
    </TooltipProvider>
  )
}
