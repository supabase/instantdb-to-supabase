import { z } from 'zod'

import { phases } from '../client/contracts'
import type { TelemetryEvent } from './events'

export type ImportTelemetryEvent = Extract<TelemetryEvent, { action: `instant_import_${string}` }>
export type EventMap = { [E in ImportTelemetryEvent as E['action']]: E['properties'] }
const count = z.number().int().nonnegative().safe()
const connectionAction = z.enum([
  'connect',
  'disconnect',
  'refresh',
  'createProject',
  'selectProject',
])
const importAction = z.enum([
  'folder',
  'upload',
  'connect',
  'disconnect',
  'retry',
  'cancel',
  'pause',
])
const handoffType = z.enum([
  'policy',
  'setup',
  'policySql',
  'cli',
  'tables',
  'auth',
  'storage',
  'policies',
  'migrations',
])
const event = <A extends string, P extends z.ZodRawShape>(action: A, properties: P) =>
  z.object({ action: z.literal(action), properties: z.object(properties).strict() }).strict()
const backup = {
  fileCount: count.max(10000),
  totalBytes: count,
  importMode: z.enum(['new', 'resume']),
}
export const browserEventSchema = z.discriminatedUnion('action', [
  event('$pageview', {}),
  event('instant_import_connection_clicked', { connectionAction }),
  event('instant_import_destination_updated', { connectionAction }),
  event('instant_import_backup_added', backup),
  event('instant_import_submitted', backup),
  event('instant_import_control_clicked', { importAction }),
  event('instant_import_action_failed', { importAction }),
  event('instant_import_handoff_opened', { handoffType }),
  event('instant_import_handoff_copied', { handoffType }),
  event('instant_import_destination_clicked', { handoffType }),
])
export const progressStageSchema = z.enum([
  'completed',
  'blocked',
  'cancelled',
  ...phases.map((phase) => phase.id),
] as const)
export type BrowserEvent = z.infer<typeof browserEventSchema>
