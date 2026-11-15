/** Automations: resume, pause, run and inspect scheduled, event, context or supervised script triggers. */
import type { Tx } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import type { Automation, AutomationListItem, CreateArgs } from './types.ts'
export type AutomationsService = {
  /** Create an automation as the tool's create does; `subscribers` stand in for a caller. Commits. */
  create(args: CreateArgs): Promise<Automation>
  /** Delete a record, retiring its scheduler; files and conversations remain. Commits. */
  delete(id: string): Promise<void>
  /** Resume a trigger from its current settings/executable. Commits; call outside transactions. */
  resume(id: string): Promise<AutomationListItem>
  /** Pause a trigger and terminate its script process group. Commits. */
  pause(id: string): Promise<AutomationListItem>
  /** Fire a schedule, event or condition now, or relaunch a script. Commits. */
  run(id: string): Promise<AutomationListItem>
  /** The record, including whether its script process is alive. */
  status(id: string): Promise<AutomationListItem>
  /**
   * The record of `id` as `tx` sees it, a plain copy, or undefined once deleted: for a check (enabled) that must hold
   * in the same transaction as the effect it allows.
   */
  read(tx: Tx, id: string): Promise<Automation | undefined>
}
/** The automations service. */
export const AutomationsApi = defineApi<AutomationsService>()('automations')
export const tier = 'core'
export { Fired, Started, Exited, Done, Escalated } from './refs.ts'
