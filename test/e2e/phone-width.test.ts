// On a 375 px phone (an iPhone 13 mini) the transcript once scrolled sideways: an error notice's long JSON sat in a flex
// row that never shrank below its longest token, inline code with a commit range ran past the message card, and a
// long agent label in the header widened the whole page. Every transcript row then slid left with the swipe.
import { join, resolve } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { context } from '../../server/harness.ts'
import { Metadata } from '../../server/metadata.ts'
import { fauxServer, post, removeTemp, temp } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

const range = '6b64a4b8943f86cdfdad81b79ce43348bc77f9d1..78d60efe6b64a4b8943f86cdfdad81b79ce4'
const failure = `400: {"message":"invalid_request_body_for_this_model_see_https://example.com/docs/errors/${'x'.repeat(60)}","type":"api_error","param":null}`

it('keeps the page and the transcript within a 375 px phone', async () => {
  const home = await temp('ultimate-phone-width-')
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
})
