// A side chat is a fork that keeps its parent's prompt: its own entries carry no system prompt, so its transcript had
// no start card. The pinned prompt, which floats over the transcript until the start card scrolls into view, then
// stayed at the very top and covered the side chat's first rows, out of reach of the scroll. It also never gave way
// to a start card that was there: the transcript's elements were read once, before the transcript mounted, and only
// new entries made the pinned prompt look again.
import { join } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../../browser/server.ts'
import { context } from '../../../../server/harness.ts'
import { prebuiltServer, post, removeTemp, temp, until } from '../../../../test/helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

const long = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(40)

it('opens a side chat at the top with its first row clear of the pinned prompt', async () => {
  const home = await temp('ultimate-fork-start-')
  cleanup.push(() => removeTemp(home))
  const server = await prebuiltServer({ userHome: home, home: join(home, 'state'), port: 0 })
  cleanup.push(() => server.close())
  server.host.faux!.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage(long)))
  const { data } = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'ultimate' },
  })
  const main = data.result as ConversationId
  const say = async (id: ConversationId, content: string) =>
    (
      await (await server.harness.conversation(id, context))!.submit(
        { type: 'input', content },
        context,
      )
    ).wait(context)
  await say(main, 'hello')
  // The first turn's prompt differs from the settled one; the side chat forks after the second, at an equal prompt.
  await say(main, 'again')
  const opened = await post(server, '/api/extensions/side-chat/actions/open', {
    args: { text: 'first side question' },
    conversationId: main,
  })
  const side = opened.data.result.id as ConversationId
  await say(side, 'second side question')

  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(`${server.url}/?conversation=${side}`)
  const transcript = page.locator('[data-ui="transcript"]')
  const pinned = page.locator('[data-ui="pinned-prompt"]')
  const top = () => transcript.evaluate((column) => column.parentElement!.scrollTop)
  await transcript.getByText('second side question').waitFor()
  await transcript.hover()
  await page.mouse.wheel(0, -100_000)
  await until(async () => (await top()) === 0, 5_000)
  expect(await transcript.locator('[data-entry-id]:visible').first().innerText()).toContain(
    'first side question',
  )
  await transcript
    .locator('[data-context-header="start"]:not([data-ui="pinned-prompt"] *)')
    .waitFor()
  await expect.poll(() => pinned.count()).toBe(0)
  // Past the start card the prompt pins again.
  await page.mouse.wheel(0, 600)
  await pinned.waitFor()
})
