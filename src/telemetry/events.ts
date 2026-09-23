export interface InstantImportConnectionEvent {
  action: 'instant_import_connection_clicked' | 'instant_import_destination_updated'
  properties: {
    connectionAction: 'connect' | 'disconnect' | 'refresh' | 'createProject' | 'selectProject'
  }
}
/**
 * Verified outcome of a Supabase OAuth callback.
 * @group Events
 * @source instant-import OAuth callback after state validation and token exchange
 * @page /api/supabase/callback
 */
export interface InstantImportConnectionResultEvent {
  action: 'instant_import_connection_completed' | 'instant_import_connection_failed'
  properties: { connectionResult: 'connected' | 'denied' | 'error' }
}
/**
 * Backup selection or upload submission, with aggregate sizes only.
 * @group Events
 * @source instant-import folder selection and upload handlers
 * @page /
 */
export interface InstantImportBackupEvent {
  action: 'instant_import_backup_added' | 'instant_import_submitted'
  properties: { fileCount: number; totalBytes: number; importMode: 'new' | 'resume' }
}
/**
 * A successful upload, an explicit import control, or a sanitized action failure.
 * @group Events
 * @source instant-import action handlers; upload completion is emitted by the server after freezing the backup
 * @page /
 */
export interface InstantImportActionEvent {
  action:
    | 'instant_import_upload_completed'
    | 'instant_import_control_clicked'
    | 'instant_import_action_failed'
  properties: {
    importAction: 'folder' | 'upload' | 'connect' | 'disconnect' | 'retry' | 'cancel' | 'pause'
  }
}
export type InstantImportStage =
  | 'analyzing'
  | 'validating'
  | 'schema'
  | 'auth'
  | 'files'
  | 'rows'
  | 'links'
  | 'constraints'
  | 'verify_links'
  | 'verifying'
  | 'reports'
  | 'cleanup'
  | 'completed'
  | 'blocked'
  | 'cancelled'
/**
 * A persisted import stage or outcome, including when the browser is closed.
 * @group Events
 * @source instant-import worker after a committed phase transition or exhausted Workflow retries
 */
export interface InstantImportProgressEvent {
  action:
    | 'instant_import_stage_updated'
    | 'instant_import_completed'
    | 'instant_import_failed'
    | 'instant_import_closed'
  properties: { jobId: string; importStage: InstantImportStage; elapsedMs: number }
}
/**
 * Explicit handoff interactions. Captures categories, never prompts, SQL, or URLs.
 * @group Events
 * @source instant-import handoff disclosure, successful clipboard copy, and destination link handlers
 * @page /
 */
export interface InstantImportHandoffEvent {
  action:
    | 'instant_import_handoff_opened'
    | 'instant_import_handoff_copied'
    | 'instant_import_destination_clicked'
  properties: {
    handoffType:
      | 'policy'
      | 'setup'
      | 'policySql'
      | 'cli'
      | 'tables'
      | 'auth'
      | 'storage'
      | 'policies'
      | 'migrations'
  }
}

export type TelemetryEvent =
  | InstantImportConnectionEvent
  | InstantImportConnectionResultEvent
  | InstantImportBackupEvent
  | InstantImportActionEvent
  | InstantImportProgressEvent
  | InstantImportHandoffEvent
