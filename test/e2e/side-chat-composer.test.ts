// The side-chat extension wraps @ultimate's composer once the standing-agents document names it. That document arrives
// after the composer first renders, so the wrap must not remount the editor or the paperclip's file input: a remount
// discards a file picked in between. The page holds back the real delivery of that document (its `doc` and `docOps`
// stream events) until the test releases it, after the conversation's paperclip is enabled and both nodes are marked.
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { fauxServer, post, removeTemp, temp } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('keeps the composer editor and file input when the standing agents document arrives', async () => {
  const home = await temp('ultimate-side-composer-')
  cleanup.push(() => removeTemp(home))
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.addInitScript(() => {
    type Gate = { held: (() => void)[]; open: boolean; release: () => void }
    const gate: Gate = {
      held: [],
      open: false,
      release() {
        gate.open = true
        for (const deliver of gate.held.splice(0)) deliver()
      },
    }
    ;(window as unknown as { standingGate: Gate }).standingGate = gate
    // oxlint-disable-next-line typescript/unbound-method -- called below with the EventSource as `this`.
    const add = EventSource.prototype.addEventListener as (
      this: EventSource,
      name: string,
      listener: (event: MessageEvent<string>) => void,
    ) => void
    EventSource.prototype.addEventListener = function (
      this: EventSource,
      name: string,
      listener: (event: MessageEvent<string>) => void,
    ) {
      if (name !== 'doc' && name !== 'docOps') return add.call(this, name, listener)
      return add.call(this, name, (event) => {
        // Payload: "<stream handler id>\n<json>".
        const raw = event.data
        const { kind } = JSON.parse(raw.slice(raw.indexOf('\n') + 1)) as { kind: string }
        if (kind !== 'ultimate.standing-agents' || gate.open) return listener(event)
        gate.held.push(() => listener(event))
      })
    } as typeof EventSource.prototype.addEventListener
  })
  const { data } = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'ultimate' },
  })
  await page.goto(`${server.url}/?conversation=${data.result}`)
  const editor = page.locator(
    `#app [data-ui="composer"] textarea[data-conversation="${data.result}"]`,
  )
  const input = page.locator(
    '#app [data-ui="composer"] label[aria-label="Attach files"] input[type="file"]:enabled',
  )
  await editor.waitFor()
  await input.waitFor({ state: 'attached' })
  // The side-chat wrapper only reports its mode once the standing document is known, so none yet.
  expect(await page.locator('#app [data-side-mode]').count()).toBe(0)
  await editor.evaluate((node) => {
    ;(node as unknown as { marked: boolean }).marked = true
  })
  await input.evaluate((node) => {
    ;(node as unknown as { marked: boolean }).marked = true
  })
  await page.evaluate(() =>
    (window as unknown as { standingGate: { release(): void } }).standingGate.release(),
  )
  await page.locator('#app [data-side-mode="normal"]').waitFor()
  const kept = await page.evaluate(() => {
    const flagged = (selector: string) =>
      (document.querySelector(selector) as unknown as { marked?: boolean } | null)?.marked === true
    return {
      editor: flagged('#app [data-ui="composer"] textarea'),
      input: flagged(
        '#app [data-ui="composer"] label[aria-label="Attach files"] input[type="file"]',
      ),
    }
  })
  expect(kept).toEqual({ editor: true, input: true })
})
