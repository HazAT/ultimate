// A question row in the To-dos panel, clicked from another conversation, reveals the entry that sent the message.
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { Messages } from '../../extensions/messages/api.ts'
import { callerOf } from '../../extensions/messages/caller.ts'
import { context } from '../../server/harness.ts'
import { fauxServer, post, removeTemp, temp, until } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('reveals the asking entry when the link is clicked from another conversation', async () => {
  const home = await temp('ultimate-messages-open-')
  cleanup.push(() => removeTemp(home))
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  const route: FauxResponseFactory = () =>
    fauxAssistantMessage(
      [fauxToolCall('message', { to: 'user', text: 'Ship the preview?', reply: true })],
      { stopReason: 'toolUse' },
    )
  const filler: FauxResponseFactory = () =>
    fauxAssistantMessage(
      Array.from({ length: 30 }, (_, line) => `Later line ${line}.`).join('\n\n'),
    )
  server.host.faux!.setResponses([route, filler, filler, filler])
  const { data } = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'ultimate' },
  })
  const ultimate = data.result as ConversationId
  const conversation = (await server.harness.conversation(ultimate, context))!
  await (await conversation.submit({ type: 'input', content: 'ask' }, context)).wait(context)
  const ask = async () =>
    (await server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))?.messages.findLast(
      (m) => m.to === 'user' && m.reply,
    )
  await until(async () => !!(await ask()))
  // Later turns push the asking entry out of view while it stays inside the page the transcript loads first.
  for (const content of ['one', 'two', 'three'])
    await (await conversation.submit({ type: 'input', content }, context)).wait(context)
  const asked = callerOf(
    (await conversation.entries({}, 100, undefined, context)).items,
    (await ask())!.call!.split('/')[0],
  )!.id

  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  // Where the asking entry is: not loaded, loaded but outside the scroller's viewport, or in it. A string, as below.
  const place = () =>
    page.evaluate(`(() => {
      const row = document.querySelector('[data-entry-id="${asked}"]')
      if (!row) return 'absent'
      let scroller = row.parentElement
      while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
      if (!scroller) return 'absent'
      const box = row.getBoundingClientRect()
      const view = scroller.getBoundingClientRect()
      return box.top >= view.top - 1 && box.top < view.bottom ? 'in view' : 'out of view'
    })()`)
  // The first load may reload the page once (dependency optimisation), which destroys the evaluation context.
  const placed = () => place().catch(() => 'reloading')
  // Opened on its own, the conversation follows its newest turn: the asking entry is loaded and scrolled away.
  await page.goto(`${server.url}/?conversation=${ultimate}`)
  await until(async () => (await placed()) === 'out of view')
  await page.goto(`${server.url}/?conversation=${ROOT_CONVERSATION_ID}`)
  await page.getByLabel('Toggle panel').click()
  const row = page.getByRole('button', { name: /Ship the preview\?/ })
  await row.waitFor()
  // Record the reveals the page asks for; a string, because the test runner rewrites `import()` in functions.
  await page.evaluate(`(async () => {
    const { events } = await import('/src/sdk/events.ts')
    window.seen = []
    const emit = events.emit.bind(events)
    events.emit = (name, value) => {
      if (name === 'ultimate:reveal-entry') window.seen.push(value)
      return emit(name, value)
    }
  })()`)
  await row.click()
  await page.waitForURL(`**/?conversation=${ultimate}`)
  await until(async () => (await page.evaluate(() => (window as any).seen.length)) > 0)
  expect(await page.evaluate(() => (window as any).seen[0])).toEqual({
    conversationId: ultimate,
    entryId: asked,
  })
  await until(async () => (await placed()) === 'in view')
}, 60_000)
