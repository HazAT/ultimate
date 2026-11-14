import type { ConversationId } from '@earendil-works/pi-durable'
/** Side chat decisions the web facet makes, pure for tests. Browser-safe. */
import type { SideChat, SideChatIndex } from './refs.ts'

/** What a composer key event carries for the Tab toggle. */
export interface TabKey {
  key: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  isComposing: boolean
}

/**
 * Whether Tab toggles side chat mode: a bare Tab, typed in @ultimate's own composer (not a side chat's: one level only),
 * while no autocomplete or mention popup claims the key. Shift+Tab stays the thinking level.
 */
export function togglesSideMode(
  event: TabKey,
  where: { conversation?: ConversationId; ultimate?: number; popup: boolean },
) {
  return (
    event.key === 'Tab' &&
    !event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.isComposing &&
    !where.popup &&
    where.conversation !== undefined &&
    where.conversation === where.ultimate
  )
}

/** Side chats still open, oldest first: ended ones went back to main as a summary or were thrown away. */
export const openSides = (index: SideChatIndex | undefined) =>
  (index?.sides ?? []).filter((side) => side.ended === undefined)

/** The side chat in front, if it is still open; a parked or ended one leaves main in front. */
export const frontSide = (front: number | null, index: SideChatIndex | undefined) =>
  openSides(index).find((side) => side.id === front)

/** An ending in flight and the last failure of one side chat's Discard or Summarize & inject. */
export type Ending = { ending?: 'discard' | 'inject'; error?: string }

/**
 * Endings by side chat id: switching side chats never shows one's failure or spinner on another, and coming back to
 * one whose inject still runs keeps its buttons disabled.
 */
export function createEndings(describe: (failure: unknown) => string) {
  const states = new Map<number, Ending>()
  const listeners = new Set<() => void>()
  const idle: Ending = {}
  const set = (side: number, next: Ending) => {
    states.set(side, next)
    for (const listener of listeners) listener()
  }
  return {
    get: (side: number) => states.get(side) ?? idle,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    /** Run `call` as side chat `side`'s `how` ending; a failure stays on that side chat as its error. */
    async end(side: number, how: 'discard' | 'inject', call: () => Promise<unknown>) {
      set(side, { ending: how })
      try {
        await call()
        set(side, {})
      } catch (failure) {
        set(side, { error: describe(failure).replace(/^side-chat\/\w+: /, '') })
      }
    },
  }
}

/** How a side chat may end: Discard only while it changed nothing outside itself. */
export function endings(side: Partial<SideChat> | undefined) {
  const live = side?.of !== undefined && side.ended === undefined
  return { inject: live, discard: live && !side.effects, locked: live && !!side.effects }
}
