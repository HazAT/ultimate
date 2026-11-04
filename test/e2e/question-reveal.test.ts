// "answer" on a question in To-dos opens the asker's conversation with the question's card at the top of the view. It
// once left the view at the bottom: clearing the request re-ran the effect whose cleanup cancelled the reveal's frame.
// The card must also land below the pinned prompt strip, which arrives after the jump, not at the top of the response
// that asked, whose text comes first; a short question at the end needs room below it to get there.
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { Started } from '../../extensions/messages/addresses.ts'
import { Messages } from '../../extensions/messages/api.ts'
import { context } from '../../server/harness.ts'
import { fauxServer, post, removeTemp, temp, until } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

const step = (n: number) =>
  `## Step ${n}\n\n${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(12)}\n\n- one\n- two\n- three`

it('brings the question card to the top of the view below the pinned strip', async () => {
  const home = await temp('ultimate-question-reveal-')
  cleanup.push(() => removeTemp(home))
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  // The branch asks with its reasoning first, as models do; anything else gets a long answer.
  let steps = 0
  const route: FauxResponseFactory = (transcript) => {
    server.host.faux!.appendResponses([route])
    const last = transcript.messages.at(-1)!
    if (last.role === 'user' && typeof last.content === 'string' && last.content.startsWith('ask'))
      return fauxAssistantMessage(
        [
          fauxText(`Here is my assessment. ${'It weighs both ways. '.repeat(20)}`),
          fauxToolCall('message', {
            to: 'user',
            text: `${last.content}: one decision before I go on.`,
            questions: [
              {
                text: 'Which way?',
                kind: 'choice',
                ref: '1',
                options: [
                  { label: 'this way', key: 'a', recommended: true },
                  { label: 'that way', key: 'b' },
                ],
              },
            ],
          }),
        ],
        { stopReason: 'toolUse' },
      )
    return fauxAssistantMessage(last.role === 'user' ? step(++steps) : 'Waiting on you.')
  }
  server.host.faux!.setResponses([route])
  const created = async () => (await post(server, '/api/conversations', {})).data.id as number
  const [branch, other] = [await created(), await created()]
  // Started by another conversation, the branch may ask the user.
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Started, branch as ConversationId)).by = other
  }, context)
  const say = async (id: number, content: string) =>
    (
      await (await server.harness.conversation(id as ConversationId, context))!.submit(
        { type: 'input', content },
        context,
      )
    ).wait(context)
  // One question sits between long answers, far above the bottom the conversation opens at; the other is the newest.
  for (const content of ['one', 'two', 'ask early', 'three', 'four', 'five', 'six', 'ask last'])
    await say(branch, content)
  await say(other, 'hello')
  const log = () => server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context)
  const asked = (await log())!.messages.filter((message) => message.to === 'user')
  expect(asked).toHaveLength(2)

  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    // Keep the profile in the test's TMPDIR, but let Chromium put its singleton socket in the short system temp path.
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  await post(server, '/api/ui', { set: { 'shell.panel': 'todos', 'shell.panelOpen': true } })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(`${server.url}/?conversation=${other}`)
  // How far a card's top sits below the strip's bottom, once both show.
  const gap = (id: number) =>
    page.evaluate((message) => {
      const card = document.querySelector(`[data-message-outgoing="${message}"]`)
      const strip = document.querySelector('[data-ui="pinned-prompt"]')
      return card && strip
        ? card.getBoundingClientRect().top - strip.getBoundingClientRect().bottom
        : Number.NaN
    }, id)
  // From another conversation, then within the branch: the bubble's own top margin is the only space between them,
  // and it stays so.
  for (const { id } of asked) {
    await page.locator(`[data-todo-question="${id}"] button`).click()
    await until(async () => Math.abs((await gap(id)) - 8) < 4, 10_000)
    await page.waitForTimeout(500)
    expect(Math.abs((await gap(id)) - 8)).toBeLessThan(4)
  }
})
