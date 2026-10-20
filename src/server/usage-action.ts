'use server'

import { browserEventSchema } from '../telemetry/contracts'
import { recordUsageDetached } from '../telemetry/usage'

/**
 * First-party backup for browser events, delivered as a same-origin Server Action so path-based
 * content blockers and PostHog outages do not drop it. Records no identifier.
 */
export async function recordBrowserUsage(value: unknown) {
  try {
    if (JSON.stringify(value).length > 2048) return
    const event = browserEventSchema.safeParse(value)
    if (event.success) await recordUsageDetached(event.data)
  } catch {
    /* Usage logging never surfaces to the browser. */
  }
}
