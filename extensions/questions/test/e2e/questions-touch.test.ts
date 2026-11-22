// A fingertip on the edge of Send sends the answer. Chrome's touch adjustment targets the button and clicks it, while
// the touch's own coordinates stay just outside the button's box.
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { chromium, devices } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../../browser/server.ts'
import { Messages } from '../../../messages/api.ts'
import { context } from '../../../../server/harness.ts'
import { fauxServer, post, removeTemp, temp, until } from '../../../../test/helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('sends the answer when a phone tap lands on the edge of Send', async () => {
  const home = await temp('ultimate-questions-touch-')
  cleanup.push(() => removeTemp(home))
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  const ask: FauxResponseFactory = () =>
    fauxAssistantMessage(
      [
        fauxToolCall('message', {
          to: 'user',
          text: 'Ready to print?',
          questions: [
            {
              text: 'Send it to the printer?',
              kind: 'choice',
              ref: '1',
              options: [
                { label: 'Go, send it', key: 'a', recommended: true },
                { label: 'Not now', key: 'b' },
              ],
            },
          ],
        }),
      ],
      { stopReason: 'toolUse' },
    )
  server.host.faux!.setResponses([ask, fauxAssistantMessage('Noted.')])
  const { data } = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'ultimate' },
  })
  const ultimate = data.result as ConversationId
  const conversation = (await server.harness.conversation(ultimate, context))!
  await (await conversation.submit({ type: 'input', content: 'ask' }, context)).wait(context)
  const log = () => server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context)
  const asked = async () => (await log())?.messages.findLast((m) => m.to === 'user' && m.reply)
  await until(async () => !!(await asked()))
  const { id } = (await asked())!

  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ ...devices['Pixel 7'] })
  await page.goto(`${server.url}/?inbox=${id}`)
  const send = page
    .locator(`[data-questions-card="message:${id}"]`)
    .getByRole('button', { name: `Send: answer to message ${id}`, exact: true })
  await send.waitFor()
  const box = (await send.boundingBox())!
  const finger = [{ x: box.x + box.width / 2, y: box.y + box.height + 4, radiusX: 8, radiusY: 8 }]
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: finger })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })

  const answer = async () => (await log())?.messages.find((m) => m.re === id && m.from === 'user')
  await until(async () => !!(await answer()))
  expect((await answer())!.text).toBe('1a. Send it to the printer?: Go, send it')
})
