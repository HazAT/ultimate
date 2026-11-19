/** The Solid migration progress in the browser: the measured series and today's per-extension split. Browser-safe. */
import { actionRef } from '../../../shared/extension-api.ts'

/** Non-blank front-end lines, as `scripts/frontend-weight.ts` counts them. */
export type Lines = { total: number; solid: number; react: number }

/**
 * One measured commit of `docs/frontend-progress.json`, oldest first; a measure not taken is null. `coordinator` is
 * the conversation in the commit's `Ultimate-Conversation` trailer, when the clone has the commit.
 */
export type Entry = {
  commit: string
  label: string
  date: string
  lines: Lines
  perExtension: Record<string, { react: number; solid: number }> | null
  bundleGzipKB: number | null
  entryGzipKB: number | null
  switch: { cold: number; warm: number } | null
  stream: { median: number; p95: number; max: number; taskMs: number } | null
  previews?: Previews | null
  coordinator?: number
}

/** One preview task's cost to the agent, medians of 3 fresh-page runs; `ok` when all 3 succeeded. */
export type PreviewRun = {
  calls: number
  steps: number
  screenshots: number
  kb: number
  tokens: number
  ms: number
  ok: boolean
}

/** Scripted preview tasks, old style (`selectors`) beside `ui` steps (null before they existed); `agent` a real worker. */
export type Previews = {
  scenarios: Record<string, { selectors: PreviewRun; ui: PreviewRun | null }>
  agent: { runs: number; calls: number; screenshots: number; tokens: number; ok: number } | null
}

/** Real use of browser previews in one ISO week (Monday's date), from stored history. */
export type PreviewWeek = {
  week: string
  conversations: number
  browserCalls: number
  uiSteps: number
  clickSteps: number
  evalSteps: number
  screenshots: number
}

/** `react` while no Solid file exists, `solid` when every `.tsx` but `web.tsx` is Solid, `partly` between. */
export type Status = 'react' | 'partly' | 'solid'

/** One extension (or `web/src`) in the working tree now. */
export type Live = { name: string; react: number; solid: number; status: Status }

/** `entries` empty with `missing` set while the data file does not exist yet. */
export type Progress = {
  entries: Entry[]
  previewUsage: PreviewWeek[]
  live: Live[]
  missing?: string
}

/** No arguments → the series and the live split. */
export const ProgressAction = actionRef<null, Progress>('solid-progress', 'progress')
