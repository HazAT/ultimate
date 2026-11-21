// An automated browser (an agent's own Playwright script, not only the browser tools) on `?conversation=` must not
// move the user's tabs: it once wrote its selection into the shared UI state and the user's tab followed it.
import { join } from 'node:path'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../server.ts'
import { context } from '../../../../server/harness.ts'
import { UiState } from '../../../../shared/ui-state.ts'
import { prebuiltServer, post, removeTemp, temp } from '../../../../test/helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('leaves the shared selection alone when a plain Playwright page opens another conversation', async () => {
  const home = await temp('ultimate-automated-page-')
  cleanup.push(() => removeTemp(home))
  const server = await prebuiltServer({
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  const created = async () => (await post(server, '/api/conversations', {})).data.id as number
  const [user, other] = [await created(), await created()]
  await post(server, '/api/ui', { ops: [{ key: 'shell.conversation', value: user }] })
  const shared = async () =>
    (await server.harness.snapshot(UiState, ROOT_CONVERSATION_ID, context))?.['shell.conversation']
  expect(await shared()).toBe(user)

  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage()
  await page.goto(`${server.url}/?conversation=${other}`)
  // The page shows its own conversation, and a later shell write would have been sent by now (150 ms coalescing).
  await page.locator(`textarea[data-conversation="${other}"]`).waitFor()
  await page.waitForTimeout(1000)
  expect(await shared()).toBe(user)
})
