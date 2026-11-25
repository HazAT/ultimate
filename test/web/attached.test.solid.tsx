import { settle } from '@ui-sdk/core/testing'
import { createSignal, flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Attached } from '../../web/src/app/attach.solid.tsx'
import type { PastedImage } from '../../web/src/app/attachments.ts'
import { renderSolid } from './solid-dom-setup.ts'

const harness = vi.hoisted(() => ({ resized: [] as unknown[], revoked: [] as string[] }))

beforeEach(() => {
  harness.resized.length = 0
  harness.revoked.length = 0
  vi.stubGlobal('createImageBitmap', async (_image: Blob, options: unknown) => {
    harness.resized.push(options)
    return { width: 304, height: 190, close() {} }
  })
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      getContext = () => ({ drawImage() {} })
      convertToBlob = async () => new Blob(['small'], { type: 'image/webp' })
    },
  )
  vi.stubGlobal(
    'fetch',
    async (url: string) => new Response(new Blob([url], { type: 'image/png' })),
  )
  let made = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:thumb-${++made}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
    harness.revoked.push(url)
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

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

  const thumb = container.querySelector<HTMLImageElement>('[data-ui="file-chip-image"]')
  expect(thumb?.getAttribute('src')).toBe('blob:thumb-1')
  expect(container.querySelector('img[src^="data:"]')).toBeNull()
  expect(harness.resized).toEqual([expect.objectContaining({ resizeWidth: 304 })])
  expect(container.textContent).toContain('Image 1')

  container.querySelector<HTMLButtonElement>('[aria-label="Remove image 1"]')!.click()
  flush()
  expect(container.querySelector('[data-ui="file-chip"]')).toBeNull()
  expect(harness.revoked).toEqual(['blob:thumb-1'])
})
