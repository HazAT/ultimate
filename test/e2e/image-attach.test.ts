// The composer's paperclip attaches images picked from the device, the only way in on a phone whose keyboard cannot
// paste them; the conversation receives the image.
import { join, resolve } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { fauxServer, removeTemp, temp, until } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

// A 1×1 PNG.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

it('attaches an image picked with the paperclip and sends it', async () => {
  const home = await temp('ultimate-image-attach-')
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
  const editor = page.locator('[data-ui="composer"] textarea')
  await editor.waitFor()
  await page
    .locator('[data-ui="composer"] label[aria-label="Attach images"] input[type="file"]')
    .setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: png })
  await page.locator('[data-ui="composer"] [aria-label="Remove image 1"]').waitFor()
  await editor.press('Enter')
  await until(async () => !!received)
  expect(received!.mimeType).toBe('image/png')
  expect(Buffer.from(received!.data, 'base64').equals(png)).toBe(true)
})
