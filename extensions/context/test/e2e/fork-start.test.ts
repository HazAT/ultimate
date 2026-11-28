// The pinned prompt used to cover the first rows at the top of a fork's transcript. The start card should take over
// when scrolled into view, even if no new entries have arrived since the transcript mounted.
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
  const pick = await post(server, '/api/extensions/side-chat/actions/pick', {
    args: { model: { provider: 'faux', modelId: 'faux-1' } },
    conversationId: main,
  })
  expect(pick.status).toBe(200)
  const turn = (key: string, text: string) =>
    post(server, '/api/extensions/side-chat/actions/turn', {
      args: { source: main, key, text },
      conversationId: main,
    })
  const opened = await turn('first', 'first side question')
  expect(opened.status).toBe(200)
  const side = opened.data.result.conversation as ConversationId
  await (await server.harness.conversation(side, context))!.waitForIdle(context)
  expect((await turn('second', 'second side question')).status).toBe(200)

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
