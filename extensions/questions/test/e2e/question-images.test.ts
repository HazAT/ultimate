// A screenshot goes with an answer: picked with the card's paperclip or pasted into its note field, it shows as a
// thumbnail, reaches the asking conversation's input with the answer, and shows under the answered message.
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../../browser/server.ts'
import { Messages } from '../../../messages/api.ts'
import { imagesOf } from '../../../../lib/entries.ts'
import { context } from '../../../../server/harness.ts'
import { fauxServer, post, removeTemp, temp, until } from '../../../../test/helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

// Where to keep screenshots of the card for a preview; none by default.
const shots = process.env.QUESTION_IMAGES_SHOTS

it('sends a screenshot picked or pasted on the card with the answer', async () => {
  const home = await temp('ultimate-question-images-')
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
    return last.role === 'user' && last.content === 'ask'
      ? fauxAssistantMessage(
          [
            fauxToolCall('message', {
              to: 'user',
              text: 'The usage preview is ready.',
              questions: [
                {
                  text: 'Approve the hover card?',
                  kind: 'choice',
                  ref: '1',
                  options: [
                    { label: 'approve', key: 'a', recommended: true },
                    { label: 'change something first', key: 'b' },
                  ],
                },
              ],
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
  await (await conversation.submit({ type: 'input', content: 'ask' }, context)).wait(context)
  const log = () => server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context)
  const ask = async () => (await log())?.messages.findLast((m) => m.to === 'user' && m.reply)
  await until(async () => !!(await ask()))
  const asked = (await ask())!

  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(`${server.url}/?conversation=${ultimate}`)
  const card = page.locator(`#app [data-questions-card="message:${asked.id}"]`)
  await card.locator('fieldset').first().waitFor()
  // A real screenshot to attach: the card itself.
  const shot = await card.screenshot()
  if (shots) await page.screenshot({ path: join(shots, '1-card.png') })

  // Picked with the paperclip next to the note field.
  await card.locator('label[aria-label="Attach images"] input').setInputFiles({
    name: 'card.png',
    mimeType: 'image/png',
    buffer: shot,
  })
  await card.getByRole('img', { name: 'Pasted image 1' }).waitFor()
  // And one pasted into the note field.
  await card.locator('textarea[data-note]').click()
  await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }))
    document
      .querySelector('#app textarea[data-note]')!
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }))
  }, shot.toString('base64'))
  await card.getByRole('img', { name: 'Pasted image 2' }).waitFor()
  // A third dropped on the card is the card's, not the composer's; removing it leaves two.
  await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }))
    document
      .querySelector('#app [data-questions-card]')!
      .dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }))
  }, shot.toString('base64'))
  await card.getByRole('img', { name: 'Pasted image 3' }).waitFor()
  expect(await page.locator('#app [data-ui="composer"] img').count()).toBe(0)
  await card.getByRole('button', { name: 'Remove image 3' }).click()
  await card.getByRole('img', { name: 'Pasted image 3' }).waitFor({ state: 'detached' })
  await card.locator('textarea[data-note]').fill('The tooltip still stacks:')
  await card.getByRole('button', { name: /change something first/ }).click()
  if (shots) await card.screenshot({ path: join(shots, '2-attached.png') })

  const sent = page.waitForRequest((r) => r.url().includes('/questions/actions/answer'))
  await card.getByRole('button', { name: 'Send', exact: true }).click()
  await card.getByRole('button', { name: 'Undo' }).waitFor()
  expect(await card.getByText('2 images').count()).toBe(1)
  // Keepalive cannot carry the images, so leaving the page while it waits asks first.
  expect(
    await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }),
  ).toBe(true)
  if (shots) await card.screenshot({ path: join(shots, '3-sending.png') })
  const answer = async () =>
    (await log())?.messages.find((m) => m.re === asked.id && m.from === 'user')
  expect(((await sent).postDataJSON() as { args: { images: unknown[] } }).args.images).toHaveLength(
    2,
  )
  await until(async () => (await answer())?.entry !== undefined)
  expect(await answer()).toMatchObject({
    text: '1b. Approve the hover card?: change something first\n\nNote: The tooltip still stacks:',
    attached: 2,
  })
  // The asker's input holds both images with the answer.
  const entry = (await answer())!.entry!
  const placed = await server.harness.commit((tx) => tx.entry(entry), context)
  expect(imagesOf(placed).map((image) => image.mimeType)).toEqual(['image/png', 'image/png'])
  // The answered message shows them under your answer.
  const answered = page.locator(`#app [data-compact-answer]`).first()
  await answered.getByRole('img').first().waitFor()
  if (shots) await page.screenshot({ path: join(shots, '4-answered.png') })
})
