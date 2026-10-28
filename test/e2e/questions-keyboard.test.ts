// Answers a three-question card in a real browser with only the keyboard: letter keys choose, ↑/↓ move between
// questions, Enter sends; the reply reaches @ultimate in the message's own numbering, with the note field's text after it.
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { JsonValue } from '@earendil-works/chord'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { Messages } from '../../extensions/messages/api.ts'
import { context } from '../../server/harness.ts'
import { fauxServer, post, removeTemp, temp, until } from '../helpers.ts'

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

it('answers a decisions card with letters, arrows and Enter', async () => {
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
          [fauxToolCall('message', { to: 'user', text: 'The preview is ready.', questions })],
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
  await next.waitFor({ state: 'detached' })
  await until(async () => (await picked())!.state === 'answered')

  // A third card answered in part: Send asks first; Esc keeps editing, Enter sends anyway.
  await (await conversation.submit({ type: 'input', content: 'ask' }, context)).wait(context)
  await until(async () => (await ask())!.id !== second.id)
  const third = (await ask())!
  const partial = page.locator(`[data-questions-card="message:${third.id}"]`)
  await partial.locator('fieldset').nth(2).waitFor()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('b')
  const confirm = partial.getByText('1 of 3 answered: send anyway?')
  await partial.getByRole('button', { name: 'Send 1 of 3' }).click()
  await confirm.waitFor()
  await page.keyboard.press('Escape')
  await confirm.waitFor({ state: 'detached' })
  // Keep editing opens the first question still unanswered.
  await partial.locator('[data-question="1"] fieldset[data-current]').waitFor()
  await partial.getByRole('button', { name: 'Send 1 of 3' }).click()
  await confirm.waitFor()
  await page.keyboard.press('Enter')
  // Enter in the undo window sends at once.
  await page.keyboard.press('Enter')
  const sent = async () =>
    (await log())?.messages.find((m) => m.re === third.id && m.from === 'user')
  await until(async () => !!(await sent()))
  expect((await sent())!.text).toBe(
    '1b. Branch starts in the context: drop them, rely on abstracts',
  )
})
