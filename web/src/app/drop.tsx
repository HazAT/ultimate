import { XIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { actionRef } from '../../../shared/extension-api.ts'
import { imageMimeTypes } from '../../../shared/protocol.ts'
import { base64FromBytes, maxDroppedBytes, pathFromDrop } from '../lib/drop.ts'
import { api, store } from '../sdk/client.ts'
import { errorMessage } from '../sdk/format.ts'

/** The `drop` project extension: files with that name on this machine, and the conversation's own folder. */
const Resolve = actionRef<{ name: string }, { paths: string[] }>('drop', 'resolve')
const Save = actionRef<{ name: string; data: string }, { path: string }>('drop', 'save')

/** Several files on this machine carry the dropped name; the composer lists them to choose from. */
export type DropChoice = { name: string; paths: string[] }

/** What a drop needs from the composer it lands in. */
export type Drop = {
  /** The conversation whose editor takes the path; `undefined` while it loads. */
  conversationId: number | undefined
  /** Insert `text` at the editor's cursor, as typing it would. */
  insert: (text: string) => void
  /** Add dropped images through the composer's own image path, its limits and errors included. */
  addImages: (files: File[]) => Promise<void>
  setError: (message: string | undefined) => void
  /** True while the composer takes no input, such as while it sends. */
  disabled: boolean
}

/** Where a drop lands: the composer, and the picker its hook shows when a name has several candidates. */
type Target = { element: Element; drop: Drop; pick: (choice: DropChoice) => void }

/** The composed drop targets by their wrapper element: a drop lands in the one under the pointer, else the first. */
const targets = new Map<Element, () => Omit<Target, 'element'>>()

let guarded = false

/** A drag of files, which must never navigate, wherever it is dropped. */
const carriedFiles = (data: DataTransfer | null) => data?.types.includes('Files') === true

/**
 * Whether a drag is the shell's business: a dropped file anywhere, and a drop that is not text landing in another
 * field, which keeps inserting its text where it lands as it always has.
 */
function claimed(event: DragEvent) {
  if (carriedFiles(event.dataTransfer)) return true
  const node = event.target instanceof Element ? event.target : undefined
  if (node?.closest('[data-composer-target]')) return true
  return !node?.closest('input, textarea, [contenteditable]')
}

/**
 * Make the whole shell refuse a dropped file: the browser never navigates to it, and it lands in the composer
 * instead. Without `dragover` prevented the browser allows no drop at all, so it goes with `drop`.
 */
export function installDropGuard() {
  if (guarded) return
  guarded = true
  for (const name of ['dragenter', 'dragover'] as const)
    document.addEventListener(
      name,
      (event) => {
        if (claimed(event)) event.preventDefault()
      },
      true,
    )
  document.addEventListener(
    'drop',
    (event) => {
      if (!claimed(event)) return
      event.preventDefault()
      void landed(event).catch((failure: unknown) => {
        // A drop into nothing has no composer to show it in; the console keeps the reason.
        console.error('[drop]', failure)
      })
    },
    true,
  )
}

function targetAt(node: EventTarget | null): Target | undefined {
  const under = node instanceof Element ? node.closest('[data-composer-target]') : null
  const found = under ? targets.get(under) : undefined
  if (under && found) return { element: under, ...found() }
  // A drop on the transcript belongs to the shown conversation's composer.
  for (const [element, read] of targets) return { element, ...read() }
  return undefined
}

function insertText(target: Omit<Target, 'pick'>, text: string) {
  target.drop.insert(text)
  target.element.querySelector('textarea')?.focus()
}

/** Where a drop goes: the path the drag handed over, a file found by name, or a copy of the file itself. */
async function landed(event: DragEvent) {
  const target = targetAt(event.target)
  const transfer = event.dataTransfer
  if (!target || !transfer || target.drop.disabled) return
  const { drop } = target
  if (drop.conversationId === undefined) return
  const files = [...transfer.files]
  // What the source says exactly: a file manager hands over the path, a text selection its text.
  const path = pathFromDrop(transfer.getData('text/uri-list') || transfer.getData('text/plain'))
  if (files.length === 0) {
    const text = path ?? transfer.getData('text/plain').trim()
    if (text) insertText(target, text)
    return
  }
  if (event.shiftKey) return imported(target, files)
  if (path) return insertText(target, path)
  if (files.length > 1)
    return imported(
      target,
      files,
      `${files.length} files carry no path, so they were copied into the conversation`,
    )
  const name = files[0].name
  let paths: string[]
  try {
    paths = (await api.action(Resolve, { name }, { conversationId: drop.conversationId })).paths
  } catch (failure) {
    return imported(
      target,
      files,
      `Could not look for ${name} on this machine (${errorMessage(failure)}), so it was copied into the conversation`,
    )
  }
  if (paths.length === 1) return insertText(target, paths[0])
  if (paths.length > 1) return target.pick({ name, paths })
  return imported(
    target,
    files,
    `No ${name} in this project or your folders, so it was copied into the conversation`,
  )
}

/** Copy dropped files into the conversation: images as attached images, anything else into its own folder. */
async function imported(target: Target, files: File[], reason?: string) {
  const { drop } = target
  const images = files.filter((file) => imageMimeTypes.includes(file.type))
  if (images.length) {
    try {
      await drop.addImages(images)
    } catch (failure) {
      drop.setError(errorMessage(failure))
    }
  }
  for (const file of files.filter((candidate) => !imageMimeTypes.includes(candidate.type))) {
    if (file.size > maxDroppedBytes) {
      drop.setError(
        `${file.name} is ${(file.size / (1024 * 1024)).toFixed(1)} MiB; files are copied in up to 8 MiB`,
      )
      continue
    }
    try {
      const data = base64FromBytes(new Uint8Array(await file.arrayBuffer()))
      const saved = await api.action(
        Save,
        { name: file.name, data },
        { conversationId: drop.conversationId },
      )
      insertText(target, saved.path)
    } catch (failure) {
      drop.setError(errorMessage(failure))
    }
  }
  if (reason) store.notify({ level: 'info', message: reason })
}

/** The folder of a path, `/` included, for showing a candidate as its folder and its name. */
function parent(path: string) {
  const cut = path.lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}

/**
 * Take drops for the composer this renders, and give back the ref its wrapper needs plus the picker for a name several
 * files on this machine carry.
 */
export function useDrop(drop: Drop) {
  const ref = useRef<HTMLDivElement>(null)
  const [choice, setChoice] = useState<DropChoice>()
  const latest = useRef(drop)
  useEffect(() => {
    latest.current = drop
  })
  useEffect(() => {
    const element = ref.current
    if (!element) return undefined
    targets.set(element, () => ({ drop: latest.current, pick: setChoice }))
    return () => {
      targets.delete(element)
    }
  }, [])
  const choose = (path: string) => {
    const element = ref.current
    setChoice(undefined)
    if (element) insertText({ element, drop: latest.current }, path)
  }
  const picker = choice ? (
    <div className="mb-2 rounded-lg border border-input/80 bg-card py-1.5 pr-1 pl-2 font-mono text-[11px]">
      <div className="flex items-center gap-2 pr-0.5 pb-1 text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">Which {choice.name}?</span>
        <button
          aria-label="Close the file picker"
          className="flex size-5 cursor-pointer items-center justify-center rounded-sm hover:bg-accent hover:text-foreground"
          onClick={() => setChoice(undefined)}
          type="button"
        >
          <XIcon className="size-3" />
        </button>
      </div>
      {choice.paths.map((path) => {
        const folder = parent(path)
        return (
          <button
            className="flex w-full min-w-0 cursor-pointer items-center gap-1 rounded-sm px-1 py-0.5 text-left hover:bg-accent"
            key={path}
            onClick={() => choose(path)}
            title={path}
            type="button"
          >
            <span className="min-w-0 truncate text-muted-foreground">{folder}/</span>
            <span className="shrink-0 text-foreground">{path.slice(folder.length + 1)}</span>
          </button>
        )
      })}
    </div>
  ) : undefined
  return { ref, picker }
}
