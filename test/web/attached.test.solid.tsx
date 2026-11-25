import { settle } from '@ui-sdk/core/testing'
import { createSignal, flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Attached, createAttach } from '../../web/src/app/attach.solid.tsx'
import type { Upload } from '../../web/src/app/attach.solid.tsx'
import type { DraftFile, PastedImage } from '../../web/src/app/attachments.ts'
import { boundDraft } from '../../web/src/app/drafts.ts'
import { renderSolid } from './solid-dom-setup.ts'

const harness = vi.hoisted(() => ({
  canvases: [] as [number, number][],
  made: [] as string[],
  revoked: [] as string[],
}))

beforeEach(() => {
  harness.canvases.length = 0
  harness.made.length = 0
  harness.revoked.length = 0
  vi.stubGlobal('createImageBitmap', async () => ({ width: 2560, height: 1600, close() {} }))
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      constructor(width: number, height: number) {
        harness.canvases.push([width, height])
      }
      getContext = () => ({ drawImage() {} })
      convertToBlob = async () => new Blob(['small'], { type: 'image/webp' })
    },
  )
  vi.stubGlobal(
    'fetch',
    async (url: string) => new Response(new Blob([url], { type: 'image/png' })),
  )
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    harness.made.push(`blob:thumb-${harness.made.length + 1}`)
    return harness.made.at(-1)!
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
    harness.revoked.push(url)
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const chipImage = (container: HTMLElement) =>
  container.querySelector<HTMLImageElement>('[data-ui="file-chip-image"]')?.getAttribute('src')

it('shows a pasted image as a small blob thumbnail and revokes it when removed', async () => {
  const screenshot: PastedImage = { data: 'A'.repeat(4000), mimeType: 'image/png' }
  const [images, setImages] = createSignal<readonly PastedImage[]>([screenshot])
  const container = renderSolid(() => (
    <Attached
      disabled={false}
      files={[]}
      images={images()}
      remove={() => setImages([])}
      removeFile={() => {}}
    />
  ))
  await settle()
  flush()

  expect(chipImage(container)).toBe('blob:thumb-1')
  expect(container.querySelector('img[src^="data:"]')).toBeNull()
  expect(harness.canvases).toEqual([[304, 190]])

  container.querySelector<HTMLButtonElement>('[aria-label="Remove image 1"]')!.click()
  flush()
  expect(container.querySelector('[data-ui="file-chip"]')).toBeNull()
  expect(harness.revoked).toEqual(['blob:thumb-1'])
})

it('keeps the thumbnail of an image a light box uploads as a file, and revokes it on remove', async () => {
  let text = ''
  const draft = boundDraft(
    () => text,
    (next) => {
      text = next
    },
    () => {},
    () => {},
  )
  const [files, setFiles] = createSignal<DraftFile[]>([])
  draft.subscribe(() => setFiles(draft.get().files))
  const change = (update: (current: DraftFile[]) => DraftFile[]) =>
    draft.set({ files: update(draft.get().files) })
  let progress: (note: string, at: number) => void = () => {}
  let finish: (result: { path: string }) => void = () => {}
  const upload: Upload = {
    maxBytes: 10_000_000,
    keptMs: 1,
    upload: (_file, options) => {
      progress = options.status
      return new Promise((resolve) => (finish = resolve))
    },
  }
  let attach!: ReturnType<typeof createAttach>
  const container = renderSolid(() => {
    attach = createAttach({
      images: () => [],
      setImages: () => {},
      setFiles: change,
      setError: () => {},
      disabled: () => false,
      uploads: () => [upload],
      inlineImages: () => false,
      conversation: () => undefined,
    })
    return (
      <Attached
        disabled={false}
        files={files()}
        images={[]}
        remove={() => {}}
        removeFile={(id) => change((current) => current.filter((file) => file.id !== id))}
      />
    )
  })
  const done = attach.attach([new File(['png'], 'shot.png', { type: 'image/png' })], 'drop')
  await settle()
  flush()
  expect(chipImage(container)).toBe('blob:thumb-1')

  progress('Uploading 50%', 0.5)
  flush()
  expect(harness.made).toEqual(['blob:thumb-1'])
  expect(harness.revoked).toEqual([])

  finish({ path: '/home/attachments/1-a/shot.png' })
  await done
  await settle()
  flush()
  expect(text).toContain('at `/home/attachments/1-a/shot.png`')
  expect(chipImage(container)).toBe('blob:thumb-2')
  expect(harness.revoked).toEqual(['blob:thumb-1'])

  container.querySelector<HTMLButtonElement>('[aria-label="Remove file 1: shot.png"]')!.click()
  flush()
  expect(container.querySelector('[data-ui="file-chip"]')).toBeNull()
  expect(harness.revoked).toEqual(['blob:thumb-1', 'blob:thumb-2'])
})
