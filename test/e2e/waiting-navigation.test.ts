import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { Messages } from '../../extensions/messages/api.ts'
import { context } from '../../server/harness.ts'
import { fauxServer, post, removeTemp, temp, until } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('cycles questions across the Memory-to-Agent sidebar remount, then wraps and repeats one', async () => {
  const home = await temp('ultimate-waiting-navigation-')
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
    const input = transcript.messages.findLast((message) => message.role === 'user')!
    return input.role === 'user' && (input.content === 'alpha' || input.content === 'beta')
      ? fauxAssistantMessage(
          [
            fauxToolCall('message', {
              to: 'user',
              text: `Question ${input.content}`,
              questions: [{ text: `Keep ${input.content}?`, kind: 'confirm' }],
            }),
          ],
          { stopReason: 'toolUse' },
        )
      : fauxAssistantMessage('Noted.')
  }
  server.host.faux!.setResponses([route])
  const { data } = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'ultimate' },
  })
  const ultimate = data.result as ConversationId
  const conversation = (await server.harness.conversation(ultimate, context))!
  for (const content of ['alpha', 'beta'])
    await (await conversation.submit({ type: 'input', content }, context)).wait(context)
  const log = await server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context)
  const questions = log!.messages.filter((message) => message.to === 'user' && message.reply)
  expect(questions).toHaveLength(2)
  const entries: number[] = []
  for (const message of questions) {
    const { data: caller } = await post(server, '/api/extensions/messages/actions/caller', {
      args: { conversation: ultimate, call: message.call },
    })
    entries.push(caller.result.entry)
  }

  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.addInitScript(() => {
    // oxlint-disable-next-line typescript/unbound-method -- the wrapper calls it with the original receiver below.
    const original = Element.prototype.scrollIntoView
    const revealed: string[] = []
    Object.assign(window, { revealed })
    Element.prototype.scrollIntoView = function (...args) {
      const id = this.getAttribute('data-entry-id')
      if (id) revealed.push(id)
      original.apply(this, args)
    }
  })
  await page.goto(`${server.url}/?conversation=${ultimate}`)
  const app = page.locator('#app')
  const count = app.locator('[data-waiting-count]')
  await count.waitFor()
  await app.locator('[data-memory-hint]').click()
  await app.getByText('What every new branch starts from').waitFor()
  const revealed = () => page.evaluate(() => (window as unknown as { revealed: string[] }).revealed)
  for (const [index, entry] of [entries[0], entries[1], entries[0]].entries()) {
    await count.click()
    await until(async () => (await revealed()).length > index)
    expect((await revealed())[index]).toBe(String(entry))
  }
  await app
    .locator(`[data-entry-id="${entries[1]}"]`)
    .getByRole('button', { name: 'Dismiss' })
    .click()
  await until(async () => (await count.textContent()) === '1 waiting on you')
  for (const index of [3, 4]) {
    await count.click()
    await until(async () => (await revealed()).length > index)
    expect((await revealed())[index]).toBe(String(entries[0]))
  }
})
