/** Cloud in the browser: this home's backups and joining the fleet. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'
import type { CloudState, LastBackup } from './types.ts'

/** No arguments → whether backups run here, the last backup, a running upload and a refused one. */
export const StateAction = actionRef<null, CloudState>('cloud', 'state')
/**
 * `{ force? }` → the finished backup: upload an encrypted snapshot of the database and the `ultimate/*`
 * branches, then commit it with this home's parent. Fails with the Worker's sentence when another machine backed up
 * after that parent; `force` replaces that backup. One at a time, never while paused.
 */
export const BackupAction = actionRef<{ force?: boolean } | null, LastBackup>('cloud', 'backup')
/**
 * A backup of project `project` (its key): `started` when the upload begins, `done` with the bytes before compression,
 * the compressed bytes uploaded and its duration, `failed` with a short classified `reason` (never the raw error);
 * a refused one (`conflict`) carries the Worker's sentence as `error`.
 */
export const BackupEvent = defineEvent<
  | { phase: 'started'; project: string }
  | { phase: 'done'; project: string; bytes: number; uploaded: number; ms: number }
  | { phase: 'failed'; project: string; ms: number; reason: string; error?: string }
>('cloud.backup')

/** Where a join stopped: checking the cloud (and the input), saving the two secrets, or saving the settings. */
export type JoinStep = 'check' | 'secrets' | 'settings'
export type JoinResult =
  | { ok: true; url: string; host: string; machine: string; projects: string[] }
  | { ok: false; step: JoinStep; error: string }
/** This machine's cloud setup, without secret values. */
export interface JoinState {
  /** Set when `cloud.url` and both secrets are. */
  joined?: { url: string; host: string; machine: string }
  /** `cloud.url`, when set. */
  url?: string
  /** `cloud.machine`, else the macOS LocalHostName or the hostname. */
  machine: string
  /** The secret names this machine lacks. */
  missing: string[]
}
/** No arguments → whether this machine has joined cloud backups, for the Join card. */
export const JoinStateAction = actionRef<null, JoinState>('cloud', 'joinState')
/**
 * User-only: `{ url, machine, token, snapshotKey }` → checks `GET /sync/register` with the token, then stores both
 * secrets and `cloud.url`/`cloud.machine` in the user's settings; nothing is stored when a step before fails.
 */
export const JoinAction = actionRef<
  { url: string; machine: string; token: string; snapshotKey: string },
  JoinResult
>('cloud', 'join')
