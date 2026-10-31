import { XIcon } from 'lucide-react'
import { actionRef, api, defineWebExtension, errorMessage, imageMimeTypes, notify } from '@/sdk'
import type { ComposerDrop, ComposerInput } from '@/sdk'
import { base64FromBytes, maxDroppedBytes, pathFromDrop } from './paths.tsx'

/** Files with that name on this machine, and the conversation's own folder. */
const Resolve = actionRef<{ name: string }, { paths: string[] }>('drop', 'resolve')
const Save = actionRef<{ name: string; data: string }, { path: string }>('drop', 'save')

const isImage = (file: File) => imageMimeTypes.includes(file.type)

/** What this puts the composer's error line, for the work a drop starts and cannot finish at once. */
const failed = (composer: ComposerInput) => (failure: unknown) =>
  composer.setError(errorMessage(failure))

/**
 * A dropped file gives the path it has on this machine. A browser never reveals the path behind a file dragged from
 * Finder, so this looks its name up, and asks which one when several carry it; shift copies the file in instead.
 */
function drop({ dataTransfer, shiftKey }: ComposerDrop, composer: ComposerInput): boolean {
  const files = [...dataTransfer.files]
  // What the source says exactly: a file manager hands over the path, a text selection its text.
  const path = pathFromDrop(
    dataTransfer.getData('text/uri-list') || dataTransfer.getData('text/plain'),
  )
  if (files.length === 0) {
    const text = path ?? dataTransfer.getData('text/plain').trim()
    if (!text) return false
    composer.insert(text)
    return true
  }
  if (shiftKey) {
    copyIn(composer, files).catch(failed(composer))
    return true
  }
  if (path) {
    composer.insert(path)
    return true
  }
  if (files.length > 1) {
    copyIn(
      composer,
      files,
      `${files.length} files carry no path, so they were copied into the conversation`,
    ).catch(failed(composer))
    return true
  }
  byName(composer, files[0]).catch(failed(composer))
  return true
}

/** A drag of one file with no path: find it by name on this machine, or copy it into the conversation. */
async function byName(composer: ComposerInput, file: File) {
  const name = file.name
  let paths: string[]
  try {
    paths = (await api.action(Resolve, { name }, { conversationId: composer.conversationId })).paths
  } catch (failure) {
    return copyIn(
      composer,
      [file],
      `Could not look for ${name} on this machine (${errorMessage(failure)}), so it was copied into the conversation`,
    )
  }
  if (paths.length === 1) return composer.insert(paths[0])
  if (paths.length > 1)
    return composer.show(
      <Choice
        close={() => composer.show(undefined)}
        name={name}
        paths={paths}
        pick={(path) => {
          composer.show(undefined)
          composer.insert(path)
        }}
      />,
    )
  await copyIn(
    composer,
    [file],
    `No ${name} in this project or your folders, so it was copied into the conversation`,
  )
}

/** Copy dropped files into the conversation: images as attached images, anything else into its own folder. */
async function copyIn(composer: ComposerInput, files: readonly File[], reason?: string) {
  const images = files.filter(isImage)
  if (images.length) await composer.addImages(images)
  for (const file of files.filter((candidate) => !isImage(candidate))) {
    if (file.size > maxDroppedBytes) {
      composer.setError(
        `${file.name} is ${(file.size / (1024 * 1024)).toFixed(1)} MiB; files are copied in up to 8 MiB`,
      )
      continue
    }
    try {
      const data = base64FromBytes(new Uint8Array(await file.arrayBuffer()))
      const saved = await api.action(
        Save,
        { name: file.name, data },
        { conversationId: composer.conversationId },
      )
      composer.insert(saved.path)
    } catch (failure) {
      // One file that cannot be copied in leaves the rest of the drop to land.
      composer.setError(errorMessage(failure))
    }
  }
  if (reason) notify({ level: 'info', message: reason })
}

/** The folder of a path, `/` included, for showing a candidate as its folder and its name. */
function parent(path: string) {
  const cut = path.lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}

/** Several files on this machine carry the dropped name: the composer lists them to choose from. */
function Choice({
  name,
  paths,
  pick,
  close,
}: {
  name: string
  paths: readonly string[]
  pick: (path: string) => void
  close: () => void
}) {
  return (
    <div className="mb-2 rounded-lg border border-input/80 bg-card py-1.5 pr-1 pl-2 font-mono text-[11px]">
      <div className="flex items-center gap-2 pr-0.5 pb-1 text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">Which {name}?</span>
        <button
          aria-label="Close the file picker"
          className="flex size-5 cursor-pointer items-center justify-center rounded-sm hover:bg-accent hover:text-foreground"
          onClick={close}
          type="button"
        >
          <XIcon className="size-3" />
        </button>
      </div>
      {paths.map((path) => {
        const folder = parent(path)
        return (
          <button
            className="flex w-full min-w-0 cursor-pointer items-center gap-1 rounded-sm px-1 py-0.5 text-left hover:bg-accent"
            key={path}
            onClick={() => pick(path)}
            title={path}
            type="button"
          >
            <span className="min-w-0 truncate text-muted-foreground">{folder}/</span>
            <span className="shrink-0 text-foreground">{path.slice(folder.length + 1)}</span>
          </button>
        )
      })}
    </div>
  )
}

export default defineWebExtension({
  composerInput: [{ drop }],
})
