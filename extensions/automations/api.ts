/** Automations: resume, pause, run and inspect scheduled, event, context or supervised script triggers. */
import type { Tx } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import type { EventRecord, EventToken } from '../../shared/events.ts'
import type { Automation, AutomationListItem, CreateArgs } from './types.shared.ts'
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
  /** Like `read`, the record `create` made with this `key`. */
  readByKey(tx: Tx, key: string): Promise<Automation | undefined>
  /**
   * List the owner's `event` as an event trigger, with what it means and its filter fields, until the returned function
   * removes it. Take the service with `need` at setup, call this in `onOpen` and defer the returned function there. The
   * owner reacts to the event and passes each one to `matched`.
   */
  trigger(trigger: Trigger): () => void
  /** In the owner's reactor transaction, fire every enabled automation whose event trigger matches `event`. */
  matched(tx: Tx, event: EventRecord): Promise<void>
}
/** An owner's event trigger: its token, what it means and its filter fields. */
export type Trigger = { event: EventToken; description: string; fields: Record<string, string> }
/** The automations service. */
export const AutomationsApi = defineApi<AutomationsService>()('automations')
export type HoldService = {
  /**
   * Whether automation `id` is held now, read inside `tx`: a held fire is dropped before it runs, wakes its subscribers
   * or emits `automations.fired`; a condition counts the crossing as fired and re-arms below its threshold as usual.
   */
  held(tx: Tx, id: string): Promise<boolean>
}
/**
 * The extension point through which the owner of an automation holds its fires while its own state makes them moot.
 * Dream provides it: no automatic dream in a chapter that already dreamed.
 */
export const Hold = defineApi<HoldService>()('automations.hold')
export const tier = 'core'
export { Fired, Started, Exited, Done, Escalated } from './refs.ts'
