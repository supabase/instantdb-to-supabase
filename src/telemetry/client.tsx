'use client'

import { useEffect } from 'react'

import { basePath } from '../base-path'
import { recordBrowserUsage } from '../server/usage-action'
import { browserEventSchema, type BrowserEvent, type EventMap } from './contracts'

let queue = Promise.resolve()
let queued = 0
let backups = 0
let pageviewSent = false
/** Anonymous first-party usage log, delivered even when a content blocker drops PostHog. */
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
function send(value: BrowserEvent) {
  // Serial delivery establishes the anonymous cookie before the next event.
  // Never read location/referrer, fields, error messages, SQL, or backup data.
  try {
    if (typeof window === 'undefined' || queued >= 20) return
    queued++
    queue = queue.then(async () => {
      try {
        await fetch(`${basePath}/api/telemetry`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(value),
          keepalive: true,
          signal: AbortSignal.timeout(2500),
        })
      } catch {
        /* Tracking never blocks a user action. */
      } finally {
        queued--
      }
    })
  } catch {
    /* Restricted browser environments may disable telemetry. */
  }
}
function emit(value: BrowserEvent) {
  send(value)
  backup(value)
}
export function track<A extends keyof EventMap>(action: A, properties: EventMap[A]) {
  const value = browserEventSchema.safeParse({ action, properties })
  if (value.success) emit(value.data)
}
/** Importer equivalent of Studio's typed useTrack, without its dashboard auth/router context. */
export function useTrack() {
  return track
}
export function Telemetry() {
  useEffect(() => {
    if (!pageviewSent) {
      pageviewSent = true
      emit({ action: '$pageview', properties: {} })
    }
  }, [])
  return null
}
