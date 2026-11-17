// Answers a three-question card in a real browser with only the keyboard: letter keys choose, ↑/↓ move between
// questions, Enter sends; the reply reaches @ultimate in the message's own numbering, with the note field's text after it.
// Leaving the page inside the undo window still sends the answer.
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { JsonValue } from '@earendil-works/chord/json'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../../browser/server.ts'
import { Messages } from '../../../messages/api.ts'
import { context } from '../../../../server/harness.ts'
import { fauxServer, post, removeTemp, temp, until } from '../../../../test/helpers.ts'

const questions: JsonValue[] = [
  {
    text: 'Branch starts in the context',
    kind: 'choice',
    ref: '1',
    options: [
      { label: 'one-line intent plus breadcrumb', key: 'a', recommended: true },
      { label: 'drop them, rely on abstracts', key: 'b' },
      { label: 'leave as is', key: 'c' },
    ],
  },
  {
    text: "Boxer's copied agents/ultimate.md",
    kind: 'choice',
    ref: '2',
    options: [
      { label: 'assess a way to add tools without forking it', key: 'a', recommended: true },
      { label: 'leave it', key: 'b' },
    ],
  },
  {
    text: 'Land it',
    kind: 'choice',
    ref: '3',
    options: [
      { label: 'yes', key: 'a', recommended: true },
      { label: 'no, change something first', key: 'b' },
    ],
  },
]

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

async function openCard(cardQuestions = questions) {
  const home = await temp('ultimate-questions-keys-')
  cleanup.push(() => removeTemp(home))
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  // @ultimate asks the user the three decisions on each input, and acknowledges anything else.
  const route: FauxResponseFactory = (transcript) => {
    server.host.faux!.appendResponses([route])
    const last = transcript.messages.at(-1)!
    return last.role === 'user' && last.content === 'ask'
      ? fauxAssistantMessage(
          [
            fauxToolCall('message', {
              to: 'user',
              text: 'The preview is ready.',
              questions: cardQuestions,
            }),
          ],
          {
            stopReason: 'toolUse',
          },
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
    // Keep the profile in the test's TMPDIR, but let Chromium put its singleton socket in the short system temp path.
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(`${server.url}/?conversation=${ultimate}`)
  const card = page.locator(`[data-questions-card="message:${asked.id}"]`)
  await card.locator('fieldset').nth(2).waitFor()
  return { conversation, log, ask, asked, page, card }
}

it('answers a decisions card with letters, arrows and Enter', async () => {
  const { conversation, log, ask, asked, page, card } = await openCard()
  // The composer takes focus on desktop and keeps its keys; the card takes them once the user leaves it.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  // Question 1: b; down to 2: a; down to 3: b; back up twice and change 1 to c.
  await page.keyboard.press('b')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('a')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('b')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('c')
  expect(await card.locator('[aria-pressed=true]').allTextContents()).toEqual([
    expect.stringContaining('leave as is'),
    expect.stringContaining('assess a way to add tools'),
    expect.stringContaining('no, change something first'),
  ])
  // `/` opens the note field without choosing anything; Enter there sends, past the undo window.
  await page.keyboard.press('/')
  await page.keyboard.type('Also rename the tab.')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('And soon.')
  await page.keyboard.press('Enter')
  // The undo bar fills over the undo window by itself, without relying on a @starting-style transition.
  const bar = card.locator('[data-countdown]')
  expect(await bar.evaluate((node) => node.getAnimations()[0].effect!.getTiming().duration)).toBe(
    3000,
  )
  await page.waitForTimeout(500)
  const width = await bar.evaluate((node) => node.getBoundingClientRect().width)
  const full = await bar.evaluate((node) => node.parentElement!.getBoundingClientRect().width)
  expect(width).toBeGreaterThan(0)
  expect(width).toBeLessThan(full * 0.8)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Enter')
  const answer = async () =>
    (await log())?.messages.find((m) => m.re === asked.id && m.from === 'user')
  await until(async () => !!(await answer()))
  expect((await answer())!.text).toBe(
    "1c. Branch starts in the context: leave as is\n\n2a. Boxer's copied agents/ultimate.md: assess a way to add tools without forking it\n\n3b. Land it: no, change something first\n\nNote: Also rename the tab.\nAnd soon.",
  )
  await card.waitFor({ state: 'detached' })
  // @ultimate's turn on the answer must end first: an ask submitted while it runs steers into that turn, which
  // then answers "Noted." instead of asking again.
  await until(async () => (await answer())!.state === 'answered')

  // A fresh card: Accept picks, then a single Enter sends.
  await (await conversation.submit({ type: 'input', content: 'ask' }, context)).wait(context)
  await until(async () => (await ask())!.id !== asked.id)
  const second = (await ask())!
  const next = page.locator(`[data-questions-card="message:${second.id}"]`)
  await next.locator('fieldset').nth(2).waitFor()
  await next.getByRole('button', { name: 'Accept picks' }).click()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Enter')
  const picked = async () =>
    (await log())?.messages.find((m) => m.re === second.id && m.from === 'user')
  await until(async () => !!(await picked()))
  expect((await picked())!.text).toMatch(/^1a\. .+\n\n2a\. .+\n\n3a\. Land it: yes$/)
})

it('warns and waits longer for partial multi answers, and the whole pending card cancels without losing drafts', async () => {
  const { log, asked, page, card } = await openCard([
    {
      text: 'Branch starts in the context',
      kind: 'multi',
      ref: '1',
      options: [
        { label: 'one-line intent, plus breadcrumb', key: 'a' },
        { label: 'keep abstracts', key: 'b' },
      ],
    },
    ...questions.slice(1),
  ])
  const first = card.locator('fieldset').first()
  await first.getByRole('button', { name: /one-line intent/ }).click()
  await first.getByRole('button', { name: /keep abstracts/ }).click()
  await card.locator('[data-note]').fill('Keep this note.')
  await page.clock.install()
  const send = async () => {
    await card.getByRole('button', { name: 'Send 1 of 3', exact: true }).click()
    await card.locator('[data-countdown]').waitFor()
  }
  const answer = async () =>
    (await log())?.messages.filter((m) => m.re === asked.id && m.from === 'user') ?? []
  await send()
  const bar = card.locator('[data-countdown]')
  expect(await bar.evaluate((node) => node.getAnimations()[0].effect!.getTiming().duration)).toBe(
    8000,
  )
  expect(await card.textContent()).toContain('2 unanswered')
  const footer = page.locator(`[data-message-outgoing="${asked.id}"] footer`)
  expect(await footer.innerText()).toBe('sending')
  const cancel = card.getByRole('button', { name: 'Undo sending your answer' })
  expect(await cancel.evaluate((node) => getComputedStyle(node).animationName)).toBe('pulse')
  // The top-left of the card, nowhere near the visible Undo label, is a cancellation target too.
  await cancel.click({ position: { x: 2, y: 2 } })
  expect(await card.locator('[aria-pressed=true]').allTextContents()).toEqual([
    expect.stringContaining('one-line intent, plus breadcrumb'),
    expect.stringContaining('keep abstracts'),
  ])
  expect(await card.locator('[data-note]').inputValue()).toBe('Keep this note.')
  expect(await footer.innerText()).toBe('awaiting your reply')
  expect(await answer()).toHaveLength(0)

  for (const key of ['Escape', 'u']) {
    await send()
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press(key)
    await card.locator('[data-note]').waitFor()
    expect(await card.locator('[data-note]').inputValue()).toBe('Keep this note.')
  }

  await send()
  await page.clock.runFor(3001)
  expect(await answer()).toHaveLength(0)
  await page.clock.runFor(4999)
  await until(async () => (await answer()).length === 1)
  expect((await answer())[0].text).toBe(
    '1a,b. Branch starts in the context: one-line intent, plus breadcrumb, keep abstracts\n\nNote: Keep this note.',
  )
  await page.clock.runFor(8000)
  expect(await answer()).toHaveLength(1)
})

it('sends a held answer when the page is left inside the undo window', async () => {
  const { log, asked, page, card } = await openCard()
  await card.getByRole('button', { name: 'Accept picks' }).click()
  await card.getByRole('button', { name: 'Send', exact: true }).click()
  await card.getByRole('button', { name: 'Undo' }).waitFor()
  await page.goto('about:blank')
  const answer = async () =>
    (await log())?.messages.find((m) => m.re === asked.id && m.from === 'user')
  await until(async () => !!(await answer()))
  expect((await answer())!.text).toMatch(/^1a\. .+\n\n2a\. .+\n\n3a\. Land it: yes$/)
})
