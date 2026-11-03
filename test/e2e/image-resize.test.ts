// Pasting an image too large to attach resizes it in the browser: the chip says how, and the conversation receives a
// WebP within 2000 px and 2 MiB.
import { join, resolve } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { maxImageBytes } from '../../shared/protocol.ts'
import { fauxServer, removeTemp, temp, until } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('resizes a pasted image over the limit and sends it', async () => {
  const home = await temp('ultimate-image-resize-')
  cleanup.push(() => removeTemp(home))
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  let received: { data: string; mimeType: string } | undefined
  server.host.faux!.setResponses([
    (transcript) => {
      const last = transcript.messages.at(-1)!
      if (last.role === 'user' && Array.isArray(last.content))
        received = last.content.find((block) => block.type === 'image')
      return fauxAssistantMessage('Got it.')
    },
  ])
  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(server.url)
  // After a reload the page repaints the previous view as an inert copy with a composer of its own, until the app has
  // rendered again; a paste there is lost.
  const editor = page.locator('#app [data-ui="composer"] textarea')
  await editor.waitFor()
  // A 3000×2400 PNG of noise: far over 2 MiB, as a phone photo or 5K screenshot would be.
  const size = await editor.evaluate(async (target) => {
    const canvas = new OffscreenCanvas(3000, 2400)
    const context = canvas.getContext('2d')!
    const pixels = context.createImageData(3000, 2400)
    crypto.getRandomValues(pixels.data.subarray(0, 65536))
    for (let i = 65536; i < pixels.data.length; i += 65536)
      pixels.data.copyWithin(i, ((i * 7) % 65536) & ~3, Math.min(i + 65536, pixels.data.length))
    for (let i = 3; i < pixels.data.length; i += 4) pixels.data[i] = 255
    context.putImageData(pixels, 0, 0)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    const data = new DataTransfer()
    data.items.add(new File([blob], 'big.png', { type: 'image/png' }))
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
    return blob.size
  })
  expect(size).toBeGreaterThan(maxImageBytes)
  const note = page.locator('[data-ui="composer"] p[title^="Resized"]')
  await note.waitFor()
  expect(await note.getAttribute('title')).toMatch(/^Resized \d+\.\d MB · 3000×2400 → 2000×1600$/)
  await editor.press('Enter')
  await until(async () => !!received)
  const image = received!
  expect(image.mimeType).toBe('image/webp')
  expect(Buffer.byteLength(image.data, 'base64')).toBeLessThanOrEqual(maxImageBytes)
})
