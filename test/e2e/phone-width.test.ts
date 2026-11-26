// On a 375 px phone (an iPhone 13 mini) the transcript once scrolled sideways: an error notice's long JSON sat in a flex
// row that never shrank below its longest token, inline code with a commit range ran past the message card, and a
// long agent label in the header widened the whole page. Every transcript row then slid left with the swipe.
import { join } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { context } from '../../server/harness.ts'
import { Metadata } from '../../server/metadata.ts'
import { prebuiltServer, post, removeTemp, temp, until } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

const range = '6b64a4b8943f86cdfdad81b79ce43348bc77f9d1..78d60efe6b64a4b8943f86cdfdad81b79ce4'
const failure = `400: {"message":"invalid_request_body_for_this_model_see_https://example.com/docs/errors/${'x'.repeat(60)}","type":"api_error","param":null}`

it('keeps the page and the transcript within a 375 px phone', async () => {
  const home = await temp('ultimate-phone-width-')
  cleanup.push(() => removeTemp(home))
  const server = await prebuiltServer({
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  const route: FauxResponseFactory = (transcript) => {
    server.host.faux!.appendResponses([route])
    const last = transcript.messages.at(-1)!
    return last.role === 'user' && last.content === 'fail'
      ? fauxAssistantMessage('', { stopReason: 'error', errorMessage: failure })
      : fauxAssistantMessage(`Landed \`${range}\` on main.`)
  }
  server.host.faux!.setResponses([route])
  const id = (await post(server, '/api/conversations', {})).data.id as ConversationId
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Metadata, id)).label = 'claude-code response to populate the usage state'
  }, context)
  const conversation = (await server.harness.conversation(id, context))!
  for (const content of ['land it', 'fail'])
    await (await conversation.submit({ type: 'input', content }, context)).wait(context)

  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    // Keep the profile in the test's TMPDIR, but let Chromium put its singleton socket in the short system temp path.
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  // isMobile widens the layout viewport to fit a too-wide page, as Safari does, so innerWidth shows it.
  const page = await browser.newPage({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  })
  await page.goto(`${server.url}/?conversation=${id}`)
  const transcript = page.locator('[data-ui="transcript"]')
  // Both the long code and the error notice are on screen: without them this test could pass with nothing to overflow.
  await transcript.getByText(range).waitFor()
  await transcript.getByText(failure).waitFor()
  await transcript.locator('[data-speaker]', { hasText: 'Claude code response' }).waitFor()
  const widths = await page.evaluate(() => {
    let scroller = document.querySelector('[data-ui="transcript"]')!.parentElement!
    while (getComputedStyle(scroller).overflowX === 'visible') scroller = scroller.parentElement!
    return {
      layout: innerWidth,
      page: document.documentElement.scrollWidth,
      transcript: scroller.scrollWidth - scroller.clientWidth,
    }
  })
  expect(widths).toEqual({ layout: 375, page: 375, transcript: 0 })

  // On an unfolded Pixel Fold one too-wide Inbox pane widened Android's layout viewport to 1348 px and zoomed the app
  // out: it stayed stuck at 58 % of the screen, short and narrow, until a reload. Folding and unfolding keep it exact.
  await page.evaluate(() => {
    const wide = document.createElement('div')
    wide.style.cssText = 'width: 2000px; height: 1px; flex-shrink: 0'
    document.querySelector('main')!.append(wide)
  })
  const filled = []
  for (const [width, height] of [
    [375, 812],
    [783, 680],
    [783, 320],
    [412, 800],
  ] as const) {
    await page.setViewportSize({ width, height })
    filled.push(
      await page.evaluate(() => [
        innerWidth,
        innerHeight,
        scrollX,
        Math.round(document.querySelector('.safe-area')!.getBoundingClientRect().width),
      ]),
    )
  }
  expect(filled).toEqual([
    [375, 812, 0, 375],
    [783, 680, 0, 783],
    [783, 320, 0, 783],
    [412, 800, 0, 412],
  ])
})

// Unfolding a Pixel Fold and folding it back rewrapped a long answer and left the reader thousands of pixels away from
// the paragraph they were reading.
it('keeps the paragraph being read at the top across a fold', async () => {
  const home = await temp('ultimate-fold-reading-')
  cleanup.push(() => removeTemp(home))
  const server = await prebuiltServer({ userHome: home, home: join(home, 'state'), port: 0 })
  cleanup.push(() => server.close())
  const answer = Array.from(
    { length: 40 },
    (_, n) =>
      `Paragraph ${n + 1}. ${'Folding screens rewrap long text at every width. '.repeat(6)}`,
  ).join('\n\n')
  server.host.faux!.setResponses([fauxAssistantMessage(answer)])
  const id = (await post(server, '/api/conversations', {})).data.id as ConversationId
  const conversation = (await server.harness.conversation(id, context))!
  await (await conversation.submit({ type: 'input', content: 'tell me' }, context)).wait(context)

  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({
    viewport: { width: 412, height: 800 },
    isMobile: true,
    hasTouch: true,
  })
  await page.goto(`${server.url}/?conversation=${id}`)
  await page.getByText('Paragraph 40.').waitFor()
  const scroller = page
    .locator('[data-ui="transcript"]')
    .locator('xpath=ancestor::*[contains(@class, "overflow-y-auto")][1]')
  await scroller.hover()
  await page.mouse.wheel(0, -4000)
  const reading = () =>
    scroller.evaluate((scroll) => {
      const top = scroll.getBoundingClientRect().top + 60
      const paragraph = [...scroll.querySelectorAll('p')].find(
        (p) => p.getBoundingClientRect().bottom > top,
      )
      return paragraph?.textContent?.split('.')[0]
    })
  await until(async () => (await reading()) !== 'Paragraph 40')
  const before = await reading()
  const seen = []
  for (const [width, height] of [
    [755, 700],
    [412, 800],
  ] as const) {
    await page.setViewportSize({ width, height })
    await page.evaluate(() => new Promise(requestAnimationFrame))
    seen.push(await reading())
  }
  expect(seen).toEqual([before, before])
})
