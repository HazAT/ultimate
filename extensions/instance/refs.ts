/** Instances in the browser: the preview servers started from this host, for the title bar and preview links. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** A preview server that served its UI. */
export type Preview = {
  id: string
  url: string
  /** The conversation that started it; a preview the user started (`start`) has none. */
  conversationId?: number
  /** What a preview the user started is called, such as `PR #200`. */
  label?: string
  /** The commit a preview the user started runs. */
  ref?: string
  /** False once it exited or was stopped. */
  running: boolean
  /** Where the tailnet reaches it while it runs, when it publishes itself there. */
  tailnet?: string
}

/** No arguments → the previews that served their UI, running or stopped since; a failed start is not among them. */
export const ListAction = actionRef<null, Preview[]>('instance', 'list')
/**
 * User-only: preview a commit of this project (`ref`, a sha or a ref name that is already local) as `label`, in a
 * detached checkout inside the preview's temporary home. Resolves once it serves its UI.
 */
export const StartAction = actionRef<{ ref: string; label: string }, Preview>('instance', 'start')
/** User-only: stop a preview the user started. */
export const StopAction = actionRef<{ id: string }, null>('instance', 'stop')
