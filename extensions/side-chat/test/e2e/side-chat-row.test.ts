// A side chat's sidebar row brings it to the front over @ultimate. From another surface, such as the Inbox, the row once
// only marked it "in front" and left that surface showing, since @ultimate stayed the shown conversation behind it.
import { join, resolve } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../../browser/server.ts'
import { context } from '../../../../server/harness.ts'
import { fauxServer, post, removeTemp, temp } from '../../../../test/helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('switches from the Inbox to @ultimate when a side chat row is clicked', async () => {
  const home = await temp('ultimate-side-row-')
  cleanup.push(() => removeTemp(home))
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  server.host.faux!.setResponses([fauxAssistantMessage('ok'), fauxAssistantMessage('side')])
  const { data } = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'ultimate' },
  })
  const main = data.result as ConversationId
  await (
    await (await server.harness.conversation(main, context))!.submit(
      { type: 'input', content: 'hello' },
      context,
    )
  ).wait(context)
  const opened = await post(server, '/api/extensions/side-chat/actions/open', {
    args: { text: 'aside' },
    conversationId: main,
  })
  const side = opened.data.result.id as number

  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(`${server.url}/?conversation=${main}`)
  await page.locator('button[data-surface="inbox"]').click()
  await expect.poll(() => page.title()).toMatch(/Inbox$/)

  await page.locator(`[data-side-chat-row="${side}"]`).click()
  await page.locator(`section[data-side-chat="${side}"]:not([inert])`).waitFor()
  await expect.poll(() => page.title()).not.toMatch(/Inbox$/)
  expect(await page.locator(`[data-side-chat-row="${side}"]`).getAttribute('aria-current')).toBe(
    'true',
  )
})
