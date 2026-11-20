// The transcript's own scroll-to-bottom (web/src/app/follow.ts) replaced use-stick-to-bottom in the core switch's step
// C2. It must follow a streaming reply, let the reader scroll up and stay there, take a wheel inside a tool's output
// without unpinning, return with the scroll button or a sent message, and keep the row the reader looks at in place
// when earlier history arrives above it.
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { context } from '../../server/harness.ts'
import { fauxServer, post, removeTemp, temp, until } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

const paragraph = (n: number) =>
  `## Part ${n}\n\n${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(10)}`

it('follows, escapes, returns and keeps the read row in place while history pages in', async () => {
  const home = await temp('ultimate-transcript-scroll-')
  cleanup.push(() => removeTemp(home))
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  let release: (() => void) | undefined
  const route: FauxResponseFactory = async (transcript) => {
    server.host.faux!.appendResponses([route])
    const last = transcript.messages.at(-1)!
    const asked = last.role === 'user' && typeof last.content === 'string' ? last.content : ''
    if (asked === 'output')
      return fauxAssistantMessage([fauxToolCall('bash', { command: `seq 1 400` })], {
        stopReason: 'toolUse',
      })
    if (asked === 'stream') {
      await new Promise<void>((resume) => (release = resume))
      return fauxAssistantMessage(Array.from({ length: 6 }, (_, n) => paragraph(n)).join('\n\n'))
    }
    return fauxAssistantMessage(last.role === 'toolResult' ? 'Done.' : paragraph(0))
  }
  server.host.faux!.setResponses([route])
  const id = (await post(server, '/api/conversations', {})).data.id as ConversationId
  const conversation = (await server.harness.conversation(id, context))!
  const say = async (content: string) =>
    (await conversation.submit({ type: 'input', content }, context)).wait(context)
  for (let n = 0; n < 60; n++) await say(`turn ${n}`)
  await say('output')
  await server.harness.commit(
    (tx) => tx.appendEntry(id, { kind: 'conversations.identity', data: {} }),
    context,
  )

  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(`${server.url}/?conversation=${id}`)
  await page.locator('[data-ui="transcript"] [data-ui="tool"]').last().waitFor()
  // A row a renderer leaves empty (conversations' React renderer of its identity note returns null) is hidden, and no
  // row is shown with nothing in it.
  const blank = await page.evaluate(
    () =>
      [...document.querySelectorAll('[data-ui="transcript"] > [data-entry-id]')].filter(
        (row) =>
          getComputedStyle(row).display !== 'none' && row.getBoundingClientRect().height === 0,
      ).length,
  )
  expect(blank).toBe(0)
  expect(
    await page.evaluate(() =>
      [...document.querySelectorAll('[data-ui="transcript"] > [data-entry-id]')].some(
        (row) => getComputedStyle(row).display === 'none',
      ),
    ),
  ).toBe(true)
  const place = () =>
    page.evaluate(() => {
      const scroll = document.querySelector('[data-ui="transcript"]')!.parentElement!
      return {
        top: scroll.scrollTop,
        distance: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
        button: !!document.querySelector('[aria-label="Scroll to bottom"]'),
      }
    })
  await until(async () => (await place()).distance <= 1, 10_000)

  // A wheel up that a tool's own scrolling output takes leaves the transcript following.
  const tool = page.locator('[data-ui="transcript"] [data-ui="tool"]').last()
  await tool.locator('[data-slot="collapsible-trigger"]').click()
  const output = tool.locator('pre').last()
  await output.hover()
  await output.evaluate((element) => (element.scrollTop = element.scrollHeight))
  await page.mouse.wheel(0, -200)
  await page.waitForTimeout(200)
  expect(await output.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  expect((await place()).button).toBe(false)

  // A streaming reply keeps the view at its end.
  const streamed = say('stream')
  await until(async () => release !== undefined, 10_000)
  release!()
  await until(async () => (await page.locator('text=Part 5').count()) > 0, 10_000)
  await until(async () => (await place()).distance <= 1, 5_000)
  await streamed

  // The reader scrolls up: the view stays, the button shows, and it brings the end back.
  await page.locator('[data-ui="transcript"]').hover()
  await page.mouse.wheel(0, -600)
  await until(async () => (await place()).button, 5_000)
  const held = (await place()).top
  const shownRows = await page.locator('[data-ui="transcript"] > [data-entry-id]').count()
  await say('after')
  await until(
    async () =>
      (await page.locator('[data-ui="transcript"] > [data-entry-id]').count()) > shownRows,
    10_000,
  )
  await page.waitForTimeout(300)
  expect((await place()).top).toBe(held)
  await page.locator('[aria-label="Scroll to bottom"]').click()
  await until(async () => (await place()).distance <= 1 && !(await place()).button, 5_000)

  // Earlier history pages in above the row the reader looks at without moving it.
  const anchor = await page.evaluate(async () => {
    const scroll = document.querySelector('[data-ui="transcript"]')!.parentElement!
    const rows = () => [...document.querySelectorAll('[data-ui="transcript"] > [data-entry-id]')]
    const first = rows()[0].getAttribute('data-entry-id')
    scroll.scrollTop = 40
    const row = rows().find((element) => element.getBoundingClientRect().top > 150)!
    const top = row.getBoundingClientRect().top
    const deadline = performance.now() + 8000
    while (rows()[0].getAttribute('data-entry-id') === first && performance.now() < deadline)
      await new Promise((tick) => setTimeout(tick, 50))
    await new Promise((tick) => setTimeout(tick, 300))
    return {
      paged: rows()[0].getAttribute('data-entry-id') !== first,
      drift: row.getBoundingClientRect().top - top,
    }
  })
  expect(anchor.paged).toBe(true)
  expect(Math.abs(anchor.drift)).toBeLessThan(2)

  // A sent message brings the view back to its end.
  await page.locator('textarea').fill('last')
  await page.keyboard.press('Enter')
  await until(async () => (await place()).distance <= 1, 10_000)
})
