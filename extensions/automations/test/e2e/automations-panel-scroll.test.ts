import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../../browser/server.ts'
import { context } from '../../../../server/harness.ts'
import { fauxServer, removeTemp, temp } from '../../../../test/helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('scrolls a long automations list inside its panel, never the page', async () => {
  const home = await temp('ultimate-automations-panel-')
  cleanup.push(() => removeTemp(home))
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: home,
    userHome: join(home, 'user'),
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  const caller = await server.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  for (let index = 0; index < 40; index++)
    await server.extensions.invoke(
      'automations',
      'create',
      { name: `Nightly ${index}`, schedule: 'every 24h' },
      new AbortController().signal,
      caller.id,
    )

  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.goto(`${server.url}/?conversation=${caller.id}`)
  await page.getByTitle('Show all automations').click()
  const list = page.getByRole('list', { name: 'Automations' })
  await list.getByText('Nightly 39').waitFor({ state: 'attached' })
  const sizes = await page.evaluate(() => {
    const scroller = document
      .querySelector('ul[aria-label="Automations"]')!
      .closest('.overflow-y-auto')!
    return {
      page: document.documentElement.scrollHeight,
      panelScrolls: scroller.scrollHeight > scroller.clientHeight,
    }
  })
  expect(sizes).toEqual({ page: 800, panelScrolls: true })
})
