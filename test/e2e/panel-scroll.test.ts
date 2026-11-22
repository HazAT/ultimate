// The kit's Switch and Checkbox render their hidden form input as a sibling of the button, absolutely positioned. With
// no positioned ancestor it was placed against the page, so the right panel's long Extensions list, scrolled out of
// its own box, made the whole document taller than the window: the app sat at the top and the page scrolled.
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { fauxServer, removeTemp, temp } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('keeps the page within the window while the Extensions panel scrolls its long list', async () => {
  const home = await temp('ultimate-panel-scroll-')
  cleanup.push(() => removeTemp(home))
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())

  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(server.url)
  await page.getByRole('button', { name: 'Toggle panel' }).click()
  await page.getByRole('tab', { name: 'Extensions' }).click()
  await page.getByRole('switch', { name: 'watchdog everywhere' }).waitFor({ state: 'attached' })

  const heights = await page.evaluate(() => {
    let panel = document.querySelector('[aria-label="watchdog everywhere"]')!.parentElement!
    while (getComputedStyle(panel).overflowY !== 'auto') panel = panel.parentElement!
    return {
      page: document.documentElement.scrollHeight,
      window: innerHeight,
      panelScrolls: panel.scrollHeight > panel.clientHeight,
    }
  })
  expect(heights).toEqual({ page: 900, window: 900, panelScrolls: true })
})
