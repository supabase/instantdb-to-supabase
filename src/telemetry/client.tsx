'use client'

import posthog from 'posthog-js'
import { useEffect } from 'react'
import { z } from 'zod'

import { recordBrowserUsage } from '../server/usage-action'
import { browserEventSchema, type BrowserEvent, type EventMap } from './contracts'

let enabled = false
let backups = 0
let pageviewSent = false
/** First-party usage log, delivered even when a content blocker drops PostHog. */
function backup(value: BrowserEvent) {
  try {
    if (typeof window === 'undefined' || backups >= 20) return
    backups++
    recordBrowserUsage(value)
      .catch(() => {})
      .finally(() => backups--)
  } catch {
    /* Tracking never blocks a user action. */
  }
}
function optedOut() {
  return (
    navigator.doNotTrack === '1' ||
    Boolean((navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl)
  )
}
function takeCarriedId() {
  const url = new URL(window.location.href)
  const id = new URLSearchParams(url.hash.slice(1)).get('telemetryId')
  if (id === null) return undefined
  url.hash = ''
  window.history.replaceState(null, '', url)
  return url.searchParams.has('supabase') && z.string().uuid().safeParse(id).success
    ? id
    : undefined
}
export function track<A extends keyof EventMap>(action: A, properties: EventMap[A]) {
  const value = browserEventSchema.safeParse({ action, properties })
  if (!value.success) return
  backup(value.data)
  try {
    if (enabled) posthog.capture(value.data.action, value.data.properties)
  } catch {
    /* Tracking never blocks a user action. */
  }
}
/** Importer equivalent of Studio's typed useTrack, without its dashboard auth/router context. */
export function useTrack() {
  return track
}
export function telemetryId() {
  return enabled ? posthog.get_distinct_id() : undefined
}
export function Telemetry({ apiKey }: { apiKey: string | null }) {
  useEffect(() => {
    if (pageviewSent) return
    pageviewSent = true
    backup({ action: '$pageview', properties: {} })
    try {
      const carriedId = takeCarriedId()
      if (!apiKey || optedOut()) return
      posthog.init(apiKey, {
        api_host: 'https://ph.supabase.com',
        ui_host: 'https://eu.posthog.com',
        persistence: 'memory',
        person_profiles: 'identified_only',
        bootstrap: carriedId ? { distinctID: carriedId } : undefined,
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        capture_performance: false,
        capture_heatmaps: false,
        capture_dead_clicks: false,
        capture_exceptions: false,
        disable_session_recording: true,
        disable_surveys: true,
        disable_external_dependency_loading: true,
        advanced_disable_flags: true,
      })
      posthog.register({ app: 'instant-import', source: 'instant-import' })
      enabled = true
      posthog.capture('$pageview', { page_title: document.title })
    } catch {
      /* Restricted browser environments may disable telemetry. */
    }
  }, [apiKey])
  return null
}
