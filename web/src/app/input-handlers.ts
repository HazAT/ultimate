/**
 * The shell's side of the composer input seam, without React: handing a drop or a paste to the handlers extensions
 * registered, the composer's own handling when none takes it, and the guard that keeps a dropped file from navigating
 * the page. `composer-input.tsx` registers composers here; extensions contribute `composerInput` handlers.
 */
import { imageMimeTypes } from '../../../shared/protocol.ts'
import { errorMessage } from '../sdk/format.ts'
import { composerInputs } from '../sdk/registry.ts'
import type {
  ComposerDrop,
  ComposerInput,
  ComposerInputContribution,
  ComposerPaste,
} from '../sdk/types.ts'

/** The handlers of every installed facet, a later facet's first. */
export type InputHandlers = ReturnType<typeof composerInputs>

/** The facet a handler belongs to: what it shows renders, and fails, as that facet's own UI. */
export type InputOwner = { extension: string; version: number }

/**
 * The session a handler acts with, given the facet it belongs to. The composer's own session has no owner: it shows
 * nothing, and clears whatever a handler left above the editor.
 */
export type ComposerSession = (owner?: InputOwner) => ComposerInput

/** What a handler's failure goes to: the extension that owns it, the event it was given, and the error. */
export type HandlerFailure = (extension: string, kind: 'drop' | 'paste', error: unknown) => void

/** The first handler in order whose `claim` returns true takes the event. */
function firstClaim(
  handlers: InputHandlers,
  kind: 'drop' | 'paste',
  claim: (handler: ComposerInputContribution, composer: ComposerInput) => boolean | void,
  open: ComposerSession,
  report: HandlerFailure,
): boolean {
  for (const { extension, version, ...handler } of handlers) {
    try {
      if (claim(handler, open({ extension, version }))) return true
    } catch (error) {
      report(extension, kind, error)
    }
  }
  return false
}

/** Whether a handler took the drop; the composer's own handling runs when none did. */
export function tookDrop(
  handlers: InputHandlers,
  drop: ComposerDrop,
  open: ComposerSession,
  report: HandlerFailure,
): boolean {
  return firstClaim(
    handlers,
    'drop',
    (handler, composer) => handler.drop?.(drop, composer),
    open,
    report,
  )
}

/** Whether a handler took the paste; the composer's own handling runs when none did. */
export function tookPaste(
  handlers: InputHandlers,
  paste: ComposerPaste,
  open: ComposerSession,
  report: HandlerFailure,
): boolean {
  return firstClaim(
    handlers,
    'paste',
    (handler, composer) => handler.paste?.(paste, composer),
    open,
    report,
  )
}

/**
 * What a drop does with no handler to take it: its text where the caret is, and its images as images. Without a project's
 * handler a file dragged from Finder places its name here, and its bytes go no further.
 */
export function plainDrop(drop: ComposerDrop, composer: ComposerInput) {
  const images = [...drop.dataTransfer.files].filter((file) => imageMimeTypes.includes(file.type))
  if (images.length)
    composer.addImages(images).catch((failure: unknown) => composer.setError(errorMessage(failure)))
  const text = drop.dataTransfer.getData('text/plain').trim()
  if (text) composer.insert(text)
}

/** Give a drop to the handlers, then to the composer's own handling when none took it. */
export function dropInto(
  handlers: InputHandlers,
  drop: ComposerDrop,
  open: ComposerSession,
  report: HandlerFailure,
) {
  if (!tookDrop(handlers, drop, open, report)) plainDrop(drop, open())
}

/** A drag of files, which must never navigate, wherever it is dropped. */
const carriedFiles = (data: DataTransfer | null) => data?.types.includes('Files') === true

/**
 * Whether a drag is the shell's business: a dropped file anywhere, and a drop that is not text landing in another field,
 * which keeps inserting its text where it lands as it always has.
 */
function shellDrag(event: DragEvent) {
  if (carriedFiles(event.dataTransfer)) return true
  const node = event.target instanceof Element ? event.target : undefined
  if (node?.closest('[data-composer-target]')) return true
  return !node?.closest('input, textarea, [contenteditable]')
}

/**
 * Make `shell` refuse a dropped file: the browser never navigates to it, and `land` gets the drop instead. Without
 * `dragover` prevented the browser allows no drop at all, so it goes with `drop`. This is the shell's own guard, never a
 * handler's: a file dragged onto the page is cancelled whether or not a composer or an extension is there.
 */
export function watchDrops(shell: Document, land: (event: DragEvent) => void) {
  for (const name of ['dragenter', 'dragover'] as const)
    shell.addEventListener(
      name,
      (event) => {
        if (shellDrag(event)) event.preventDefault()
      },
      true,
    )
  shell.addEventListener(
    'drop',
    (event) => {
      if (!shellDrag(event)) return
      event.preventDefault()
      land(event)
    },
    true,
  )
}
