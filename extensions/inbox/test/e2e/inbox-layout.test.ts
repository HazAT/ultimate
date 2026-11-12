// The Inbox reading pane scrolls inside the window; it once grew the whole page instead, so a reader could scroll one
// screen past the conversation into empty background. The answer card carries absolutely positioned `sr-only` legends
// (one per question, extensions/questions/question.tsx): with no positioned ancestor their containing block was the page,
// so they laid themselves out at their static position below the window and stretched the document.
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import type { Page } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../../browser/server.ts'
import { Started } from '../../../messages/addresses.ts'
import { context } from '../../../../server/harness.ts'
import { fauxServer, post, removeTemp, temp } from '../../../../test/helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

const body = Array.from(
  { length: 8 },
  (_, index) =>
    `## Section ${index + 1}\n\n${'It weighs both ways and the numbers move. '.repeat(10)}\n`,
).join('\n')

/** How much taller than the window the document is, and whether the reading pane itself scrolls. */
const layout = (page: Page) =>
  page.evaluate(() => {
    const item = document.querySelector('[data-inbox-item]')!
    const pane = [item, ...item.querySelectorAll('*')].find(
      (element) => getComputedStyle(element).overflowY === 'auto',
    )!
    return {
      beyond: document.documentElement.scrollHeight - innerHeight,
      paneScrolls: pane.scrollHeight > pane.clientHeight,
    }
  })

/** A branch asking five questions in one long message, whose card fills more than a window. */
async function setup() {
  const home = await temp('ultimate-inbox-layout-')
  cleanup.push(() => removeTemp(home))
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  const route: FauxResponseFactory = (transcript) => {
    server.host.faux!.appendResponses([route])
    const last = transcript.messages.at(-1)!
    if (last.role === 'user' && typeof last.content === 'string' && last.content.startsWith('ask'))
      return fauxAssistantMessage(
        [
          fauxText(`${body}Five decisions before I go on.`),
          fauxToolCall('message', {
            to: 'user',
            text: `${body}Five decisions before I go on.`,
            questions: Array.from({ length: 5 }, (_, index) => ({
              text: `Decision ${index + 1}: where should it sit, and how should it move?`,
              kind: 'choice' as const,
              ref: String(index + 1),
              options: [
                { label: 'in the sidebar, under the project', key: 'a', recommended: true },
                { label: 'in the status line at the bottom', key: 'b', recommended: false },
              ],
            })),
          }),
        ],
        { stopReason: 'toolUse' },
      )
    return fauxAssistantMessage('Fine.')
  }
  server.host.faux!.setResponses([route])
  const created = async () => (await post(server, '/api/conversations', {})).data.id as number
  const [branch, other] = [await created(), await created()]
  // Started by another conversation, the branch may ask the user.
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Started, branch as ConversationId)).by = other
  }, context)
  const say = async (content: string) =>
    (
      await (await server.harness.conversation(branch as ConversationId, context))!.submit(
        { type: 'input', content },
        context,
      )
    ).wait(context)
  await say('one')
  await say('ask the user')
  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    // Keep the profile in the test's TMPDIR, but let Chromium put its singleton socket in the short system temp path.
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  // The asking conversation's card names the message; the same card is the Inbox's item.
  const probe = await browser.newPage()
  await probe.goto(`${server.url}/?conversation=${branch}`)
  const card = probe.locator('[data-message-outgoing]').first()
  await card.waitFor()
  const message = Number(await card.getAttribute('data-message-outgoing'))
  expect(message).toBeGreaterThan(0)
  await probe.close()
  return { server, browser, message }
}

it('scrolls the reading pane inside the window, never the page', async () => {
  const { server, browser, message } = await setup()
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport })
    // `?inbox=` opens the surface at the message, which is how a phone reaches an item.
    await page.goto(`${server.url}/?conversation=1&inbox=${message}`)
    await page.locator('[data-inbox-item]').waitFor()
    const { beyond, paneScrolls } = await layout(page)
    // The message and its card make the pane scroll: without that this test could pass with nothing to overflow.
    expect(paneScrolls).toBe(true)
    expect(beyond).toBeLessThanOrEqual(0)
    await page.close()
  }
})
