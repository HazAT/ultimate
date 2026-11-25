import { resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import type { ConversationId } from '@earendil-works/pi-durable'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { context } from '../../server/harness.ts'
import { fauxServer, post, removeTemp, temp, until } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('keeps the reading position, the caret and keys typed during the reload', async () => {
  const home = await temp('ultimate-reload-place-')
  cleanup.push(() => removeTemp(home))
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: `${home}/state`,
    port: 0,
  })
  cleanup.push(() => server.close())
  server.host.faux!.setResponses(
    Array.from({ length: 8 }, (_, n) =>
      fauxAssistantMessage(`Reply ${n}\n\n${'A long paragraph of reply text. '.repeat(60)}`),
    ),
  )
  const id = (await post(server, '/api/conversations', {})).data.id as ConversationId
  const conversation = (await server.harness.conversation(id, context))!
  for (let n = 0; n < 8; n++)
    await (
      await conversation.submit({ type: 'input', content: `question ${n}` }, context)
    ).wait(context)

  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  await page.goto(`${server.url}/?conversation=${id}`)
  const transcript = page.locator('#app [data-ui="transcript"]')
  await transcript.getByText('Reply 7').waitFor()
  const reading = () =>
    page.evaluate(() => {
      const scroll = document.querySelector('#app [data-ui="transcript"]')!.parentElement!
      const viewTop = scroll.getBoundingClientRect().top
      const row = [...scroll.querySelectorAll('[data-entry-id]')].find(
        (element) => element.getBoundingClientRect().bottom > viewTop,
      )!
      return {
        entry: row.getAttribute('data-entry-id'),
        top: Math.round(row.getBoundingClientRect().top - viewTop),
        fromBottom: Math.round(scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop),
      }
    })
  await until(async () => (await reading()).fromBottom <= 1)
  await transcript.hover()
  await page.mouse.wheel(0, -2500)
  await until(async () => (await reading()).fromBottom > 2000)
  const before = await reading()

  const box = page.locator('#app textarea').first()
  await box.click()
  await page.keyboard.type('hello world')
  await box.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(5, 5))

  await page.reload({ waitUntil: 'commit' })
  await page.locator('#resume').waitFor({ state: 'attached' })
  await page.keyboard.type('XY')
  await box.waitFor({ state: 'attached' })
  await page.keyboard.type('Z')
  await page.locator('#resume').waitFor({ state: 'detached' })

  expect(await reading()).toEqual(before)
  expect(
    await box.evaluate((element: HTMLTextAreaElement) => ({
      value: element.value,
      caret: element.selectionStart,
      focused: document.activeElement === element,
    })),
  ).toEqual({ value: 'helloXYZ world', caret: 8, focused: true })
})
