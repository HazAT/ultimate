// Switching between instances in one tab kept every page Chromium froze into the back/forward cache with its
// /api/events stream open. Over plain HTTP/1.1 (127.0.0.1) the browser allows six connections per origin, so the
// sixth visit to one instance found them all held by frozen pages: its reads stayed pending and it never loaded.
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { fauxServer, removeTemp, temp, until } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('frees the event stream of a page kept in the back/forward cache', async () => {
  const home = await temp('ultimate-bfcache-')
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
    ignoreDefaultArgs: ['--disable-back-forward-cache'],
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage()
  await page.addInitScript(() =>
    addEventListener('pageshow', (event) => {
      document.documentElement.dataset.restored = String(event.persisted)
    }),
  )
  const answers = () =>
    page.evaluate(() =>
      fetch('/api/models', { cache: 'no-store', signal: AbortSignal.timeout(5000) }).then(
        (response) => response.ok,
        () => false,
      ),
    )
  for (let visit = 0; visit < 8; visit++) {
    await page.goto(`${server.url}/?visit=${visit}`)
    await page.locator('[data-ui="transcript"]').first().waitFor()
    expect({ visit, answers: await answers() }).toEqual({ visit, answers: true })
  }
  await until(() => server.api.pages() === 1)
  await page.goBack({ waitUntil: 'commit' })
  await page.locator('html[data-restored="true"]').waitFor()
  await until(() => server.api.pages() === 1)
  expect(await answers()).toBe(true)
})
