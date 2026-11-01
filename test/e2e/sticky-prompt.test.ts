// Scrolls up through long answers in a real browser: a line at the top names the turn of the user's they answer, cut to
// its first phrase, and a click on it scrolls back to that turn.
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { context } from '../../server/harness.ts'
import { fauxServer, post, removeTemp, temp } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

const answer = (topic: string) =>
  Array.from({ length: 40 }, (_, index) => `${topic} paragraph ${index + 1}.`).join('\n\n')

/** A faux server whose @ultimate answered `inputs` with `answers`; `disable` goes into the user's settings. */
async function served(inputs: string[], answers: string[], disable: string[] = []) {
  const home = await temp('ultimate-sticky-prompt-')
  cleanup.push(() => removeTemp(home))
  await mkdir(join(home, '.ultimate'))
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable } }),
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  server.host.faux!.setResponses(answers.map((text) => fauxAssistantMessage(text)))
  const { data } = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'ultimate' },
  })
  const ultimate = data.result as ConversationId
  const conversation = (await server.harness.conversation(ultimate, context))!
  for (const content of inputs)
    await (await conversation.submit({ type: 'input', content }, context)).wait(context)
  return { server, ultimate }
}

async function open(url: string) {
  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(url)
  // Vite may reload the page once while it optimizes dependencies; the reload's cover paints a copy of the old
  // transcript outside #app, so every lookup stays inside the live app.
  return { page, log: page.locator('#app').getByRole('log') }
}

it('pins the answered turn while scrolled up and reveals it on click', async () => {
  const { server, ultimate } = await served(
    ['Explain alpha first. Then everything else about it.', 'Now explain beta. And the rest.'],
    [answer('Alpha'), answer('Beta')],
  )
  const { page, log } = await open(`${server.url}/?conversation=${ultimate}`)
  await log.getByText('Beta paragraph 40.').waitFor()
  const sticky = page.locator('#app [data-sticky-prompt]')
  expect(await sticky.count()).toBe(0)

  await log.getByText('Beta paragraph 20.', { exact: true }).evaluate((node) => {
    node.scrollIntoView({ block: 'start' })
  })
  await sticky.waitFor()
  expect(await sticky.textContent()).toBe('Now explain beta…')
  // Visible, not covered: the element at its centre is the line itself.
  expect(
    await sticky.evaluate((node) => {
      const box = node.getBoundingClientRect()
      return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
    }),
  ).toBe(true)

  await log.getByText('Alpha paragraph 20.', { exact: true }).evaluate((node) => {
    node.scrollIntoView({ block: 'start' })
  })
  await page.waitForFunction(
    () =>
      document.querySelector('#app [data-sticky-prompt]')?.textContent === 'Explain alpha first…',
  )

  // A click scrolls back to the alpha turn, which then hides the line.
  await sticky.click()
  const turn = log.getByText('Explain alpha first. Then everything else about it.')
  await page.waitForFunction(() => !document.querySelector('#app [data-sticky-prompt]'))
  expect(await turn.isVisible()).toBe(true)
  const top = await turn.evaluate((node) => node.getBoundingClientRect().top)
  const view = await log.evaluate((node) => node.getBoundingClientRect())
  expect(top).toBeGreaterThanOrEqual(view.top)
  expect(top).toBeLessThan(view.bottom)
})

it('names a turn below the loaded history with one lookup and no history pages', async () => {
  const { server, ultimate } = await served(['Start the long job. Report when done.'], ['Done.'])
  // A branch's long run: 2,000 answers without a turn of the user's, dozens of history pages below what first loads.
  await server.harness.commit(async (tx) => {
    for (let index = 1; index <= 2000; index++)
      await tx.appendEntry(ultimate, {
        kind: 'pi.assistant',
        model: [fauxAssistantMessage(`Progress ${index}.`)],
      })
  }, context)
  const { page, log } = await open(`${server.url}/?conversation=${ultimate}`)
  await log.getByText('Progress 2000.', { exact: true }).waitFor()
  const requests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.includes('/history') || url.pathname.includes('/sticky-prompt/'))
      requests.push(url.pathname + url.search)
  })
  // From the middle of the loaded rows, in one step, record the line on every frame until it names the turn.
  const missing = await page.evaluate(async () => {
    const scroll = document.querySelector('#app [role=log]')!.firstElementChild!
    scroll.scrollTop = scroll.scrollHeight / 2
    let gone = 0
    for (let frame = 0; frame < 600; frame++) {
      await new Promise(requestAnimationFrame)
      const line = document.querySelector('#app [data-sticky-prompt]')
      if (frame > 2 && !line) gone++
      if (line?.textContent === 'Start the long job…') return gone
    }
    return -1
  })
  expect(missing).toBe(0)
  expect(requests).toEqual(['/api/extensions/sticky-prompt/actions/turn'])

  // A click loads the history down to the turn and scrolls to it.
  await page.locator('#app [data-sticky-prompt]').click()
  const turn = log.getByText('Start the long job. Report when done.')
  await turn.waitFor()
  await page.waitForFunction(() => !document.querySelector('#app [data-sticky-prompt]'))
  expect(await turn.isVisible()).toBe(true)
})

it('shows no line when the extension is disabled', async () => {
  const { server, ultimate } = await served(
    ['Explain beta. And the rest.'],
    [answer('Beta')],
    ['sticky-prompt'],
  )
  const { page, log } = await open(`${server.url}/?conversation=${ultimate}`)
  await log.getByText('Beta paragraph 40.').waitFor()
  await log.getByText('Beta paragraph 20.', { exact: true }).evaluate((node) => {
    node.scrollIntoView({ block: 'start' })
  })
  // The scroll button appears once the transcript stops following; the line would by then.
  await page.locator('#app [role=log] button:has(svg.lucide-arrow-down)').waitFor()
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  )
  expect(await page.locator('#app [data-sticky-prompt]').count()).toBe(0)
})
