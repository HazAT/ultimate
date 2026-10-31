import { useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, ReactNode } from 'react'
import { store } from '../sdk/client.ts'
import { errorMessage } from '../sdk/format.ts'
import { useExtensions } from '../sdk/hooks.ts'
import { composerInputs } from '../sdk/registry.ts'
import type { ComposerPaste } from '../sdk/types.ts'
import { ExtensionBoundary } from './boundary.tsx'
import { dropInto, tookPaste, watchDrops } from './input-handlers.ts'
import type {
  ComposerSession,
  HandlerFailure,
  InputHandlers,
  InputOwner,
} from './input-handlers.ts'

/**
 * The composer's input seam. A drop or a paste arrives at the composer the extensions registered handlers for: the first
 * handler in discovery order that claims it takes it, and the composer's own handling runs when none does. The shell
 * keeps two things whatever extensions exist: a file dragged anywhere never navigates the page, and a composer no handler
 * takes falls back to its own handling. See `composerInput` in extensions/README.md.
 */

/** What a composer tells the seam about itself; the session handlers see is built from it and `show`. */
type Source = {
  conversationId: number | undefined
  insert: (text: string) => void
  addImages: (files: readonly File[]) => Promise<void>
  setError: (message: string | undefined) => void
  /** True while the composer takes no input, such as while it sends. */
  disabled: boolean
}

/** What a handler asked the composer to show above its editor, and the extension it belongs to. */
type Shown = { extension: string; version: number; ui: ReactNode }

/** Where an event goes: the composer's handlers, whether it takes input, and how its handlers act on it. */
type Target = { handlers: InputHandlers; disabled: boolean; open: ComposerSession }

/** The mounted composers by their wrapper element, read when an event lands. */
const composers = new Map<Element, () => Target | undefined>()

/** What a handler showed, shown as its extension's component: the composer's own session shows nothing. */
function showAbove(
  owner: InputOwner | undefined,
  ui: ReactNode,
  setShown: (shown: Shown | undefined) => void,
) {
  setShown(ui === undefined || ui === null ? undefined : owner && { ...owner, ui })
}

/** The composer as an event finds it, or nothing while it has no conversation to place the input in. */
function targetOf(
  latest: { source: Source; handlers: InputHandlers },
  setShown: (shown: Shown | undefined) => void,
): Target | undefined {
  const { source, handlers } = latest
  const { conversationId, insert, addImages, setError } = source
  if (conversationId === undefined) return undefined
  return {
    handlers,
    disabled: source.disabled,
    // What a handler shows is that extension's component, so it renders, and fails, as one.
    open: (owner) => ({
      conversationId,
      insert,
      addImages,
      setError,
      show: (ui) => showAbove(owner, ui, setShown),
    }),
  }
}

const reported = new Set<string>()
/** A handler that throws is named once and skipped, so one broken extension leaves the composer working. */
const report: HandlerFailure = (extension, kind, error) => {
  const message = `extension ${extension}: its ${kind} handler threw: ${errorMessage(error)}`
  if (reported.has(message)) return
  reported.add(message)
  store.notify({ level: 'error', message })
}

/** The composer an event lands in: the one under the pointer, else the shown conversation's. */
function targetAt(node: EventTarget | null): Target | undefined {
  const under = node instanceof Element ? node.closest('[data-composer-target]') : null
  const found = under ? composers.get(under) : undefined
  if (under && found) return found()
  // A drop on the transcript belongs to the shown conversation's composer.
  for (const read of composers.values()) return read()
  return undefined
}

/** Give the drop to the first handler that takes it, and to the composer's own handling when none does. */
function dropped(event: DragEvent) {
  const transfer = event.dataTransfer
  const target = targetAt(event.target)
  if (!transfer || !target || target.disabled) return
  dropInto(
    target.handlers,
    { dataTransfer: transfer, shiftKey: event.shiftKey },
    target.open,
    report,
  )
}

let guarded = false

/** Stop the whole shell from navigating to a dropped file, once per page. */
export function installDropGuard() {
  if (guarded) return
  guarded = true
  watchDrops(document, dropped)
}

/** What a clipboard event carries as a handler sees it: its text with `\n` line endings, and its files. */
export function pasted(event: ClipboardEvent<HTMLTextAreaElement>): ComposerPaste {
  return {
    text: event.clipboardData.getData('text').replace(/\r\n?/g, '\n'),
    files: [...event.clipboardData.files],
  }
}

/** What a handler showed above the editor, behind that extension's own boundary. */
export function ShownInput({ shown }: { shown: Shown }) {
  return (
    <ExtensionBoundary extension={shown.extension} variant="inline" version={shown.version}>
      {shown.ui}
    </ExtensionBoundary>
  )
}

/**
 * Take part in the composer this renders: give back the ref its wrapper needs, what a handler showed above the editor,
 * and whether a handler took a paste from it.
 */
export function useComposerInput(source: Source) {
  const handlers = composerInputs(useExtensions())
  const ref = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState<Shown>()
  const latest = useRef({ source, handlers })
  useEffect(() => {
    latest.current = { source, handlers }
  })
  useEffect(() => {
    const element = ref.current
    if (!element) return undefined
    const read = () => targetOf(latest.current, setShown)
    composers.set(element, read)
    return () => {
      composers.delete(element)
    }
  }, [])
  const took = (paste: ComposerPaste) => {
    const target = targetOf(latest.current, setShown)
    return (
      target !== undefined &&
      !target.disabled &&
      tookPaste(target.handlers, paste, target.open, report)
    )
  }
  return { ref, shown, took }
}
