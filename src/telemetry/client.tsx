'use client'

import { useEffect } from 'react'

import { browserEventSchema, type BrowserEvent, type EventMap } from './contracts'

let queue = Promise.resolve()
let queued = 0
let pageviewSent = false
function send(value: BrowserEvent) {
  // Serial delivery establishes the anonymous cookie before the next event.
  // Never read location/referrer, fields, error messages, SQL, or backup data.
  try {
    if (
      typeof window === 'undefined' ||
      navigator.doNotTrack === '1' ||
      (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl ||
      queued >= 20
    )
      return
    queued++
    queue = queue.then(async () => {
      try {
        await fetch('/api/telemetry', {
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
export function track<A extends keyof EventMap>(action: A, properties: EventMap[A]) {
  const value = browserEventSchema.safeParse({ action, properties })
  if (value.success) send(value.data)
}
/** Importer equivalent of Studio's typed useTrack, without its dashboard auth/router context. */
export function useTrack() {
  return track
}
export function Telemetry() {
  useEffect(() => {
    if (!pageviewSent) {
      pageviewSent = true
      send({ action: '$pageview', properties: {} })
    }
  }, [])
  return null
}
