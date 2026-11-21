import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
import { browserBinary } from '../extensions/browser/server.ts'
import { SetAction, StateAction as WarmStateAction } from '../extensions/keep-warm/refs.ts'
import { PlayAction, StateAction as PauseStateAction } from '../extensions/pause/refs.ts'
import type { ActionRef } from '../shared/extension-api.ts'
import type { Condition, TestHook } from '../web/src/sdk/test-hook.ts'
import { median, runsFlag } from './measure.ts'

type Step =
  | { click: string }
  | { fill: [string, string] }
  | { press: string }
  | { wait: number }
  | { eval: () => string | null }
  | { send: string }
  | { until: Condition }
  | { ui: 'snapshot' }
  | { ui: 'act'; steps: { ref: string; action: string; args?: unknown[] }[] }
type Call = { steps: Step[]; screenshot: boolean }
type Scenario = {
  selectors: Call[]
  ui: Call[]
  freshConversation?: true
  before?: (page: Page) => Promise<string | null>
  done: (page: Page, read: string | null, before: string | null) => boolean | Promise<boolean>
  ready?: () => Promise<void>
  restore?: () => Promise<unknown>
}
export type Measured = {
  calls: number
  steps: number
  screenshots: number
  kb: number
  tokens: number
  ms: number
  sleepMs: number
  ok: boolean
}

const [home, streamPrompt] = process.argv.slice(2)
if (!home || !streamPrompt)
  throw new Error('Usage: node scripts/preview-bench.ts <scratch home> <stream prompt> [--runs 3]')
const base = (await readFile(join(home, 'benchmark-host'), 'utf8')).trim()
const runs = runsFlag(process.argv)
const viewport = { width: 1440, height: 900 }
const bytesPerToken = 4
const pixelsPerImageToken = 750
const stateMs = 5000

async function post<Result>(path: string, data: object): Promise<Result> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(`${path}: ${await response.text()}`)
  return (await response.json()) as Result
}
const action = async <Args, Result>(ref: ActionRef<Args, Result>, args: Args) =>
  (await post<{ result: Result }>(`/api/extensions/${ref.extension}/actions/${ref.name}`, { args }))
    .result
const expect = async (holds: Promise<boolean>, what: string) => {
  if (!(await holds)) throw new Error(`Benchmark needs ${what} before it starts`)
}

const popover = '[data-slot="popover-content"], [role="dialog"]'
const old = (...steps: Step[]): Call => ({ steps: [{ wait: 1000 }, ...steps], screenshot: true })
const ui = (...steps: Step[]): Call => ({ steps, screenshot: false })
const snapshot = ui({ ui: 'snapshot' })
const theme = () =>
  `${localStorage.getItem('ultimate.theme')}/${document.documentElement.classList.contains('dark')}`
const reply = () =>
  [...document.querySelectorAll<HTMLElement>('[data-from="assistant"][data-final]')].at(-1)
    ?.innerText ?? null
const visible = (page: Page, selector: string) => page.locator(selector).isVisible()

const scenarios: Record<string, Scenario> = {
  'keep-warm': {
    selectors: [
      old(),
      old(
        { click: '[data-keep-warm]' },
        { click: `:is(${popover}) [role="switch"]` },
        { wait: 1000 },
      ),
    ],
    ui: [
      snapshot,
      ui(
        {
          ui: 'act',
          steps: [
            { ref: "Keep @ultimate's cache warm", action: 'setOpen', args: [true] },
            { ref: 'Keep @ultimate warm', action: 'setChecked', args: [false] },
          ],
        },
        { until: { ui: 'Keep @ultimate warm', is: { checked: false } } },
      ),
    ],
    done: (page) => visible(page, `:is(${popover}) [role="switch"][aria-checked="false"]`),
    ready: () =>
      expect(
        action(WarmStateAction, null).then((state) => state.on),
        'keep-warm on',
      ),
    restore: async () => {
      if (!(await action(WarmStateAction, null)).on) await action(SetAction, { on: true })
    },
  },
  pause: {
    selectors: [
      old(),
      old(
        { click: '[data-pause]' },
        { click: `:is(${popover}) [data-pause-toggle]` },
        { wait: 1000 },
      ),
    ],
    ui: [
      snapshot,
      ui(
        {
          ui: 'act',
          steps: [
            { ref: 'Pause or continue all work', action: 'setOpen', args: [true] },
            { ref: 'Pause: stop starting new work', action: 'press' },
          ],
        },
        { until: { ui: 'Play: continue paused work' } },
      ),
    ],
    done: (page) => visible(page, '[data-pause="paused"]'),
    ready: () =>
      expect(
        action(PauseStateAction, null).then((state) => !state.paused),
        'a host that is not paused',
      ),
    restore: async () => {
      if ((await action(PauseStateAction, null)).paused) await action(PlayAction, null)
    },
  },
  'setup-read': {
    selectors: [old(), old({ click: '[data-setup-issues]' }, { wait: 1000 })],
    ui: [
      snapshot,
      ui(
        { ui: 'act', steps: [{ ref: '1 setup issue', action: 'setOpen', args: [true] }] },
        { until: { ui: 'Decide' } },
      ),
    ],
    done: (page) => visible(page, `:is(${popover}) button:text-is("Decide")`),
  },
  surface: {
    selectors: [
      old(),
      old(
        { click: '[data-ui="surface-tabs"] [data-surface="system"]' },
        { wait: 1000 },
        { eval: () => document.title },
      ),
    ],
    ui: [
      ui(
        { ui: 'act', steps: [{ ref: 'System', action: 'press' }] },
        { eval: () => document.title },
      ),
    ],
    done: (_page, read) => read?.includes('System') === true,
  },
  palette: {
    selectors: [
      old(),
      old(
        { press: 'Control+k' },
        { fill: ['input[aria-label="Search commands"]', 'Toggle light and dark theme'] },
        { press: 'Enter' },
        { wait: 1000 },
        { eval: theme },
      ),
    ],
    ui: [
      ui(
        {
          ui: 'act',
          steps: [
            { ref: 'Command palette', action: 'press' },
            { ref: 'Search commands', action: 'run', args: ['theme.toggle'] },
          ],
        },
        { eval: theme },
      ),
    ],
    before: (page) => page.evaluate(theme),
    done: (_page, read, before) => read !== null && read !== before,
  },
  stream: {
    freshConversation: true,
    selectors: [
      old(),
      old(
        { fill: ['#composer-input', streamPrompt] },
        { press: 'Enter' },
        { wait: 5000 },
        { eval: reply },
      ),
    ],
    ui: [ui({ send: streamPrompt }, { until: 'idle' }, { eval: reply })],
    done: (_page, read) => read?.includes('Paragraph 5') === true,
  },
}

async function step(page: Page, item: Exclude<Step, { eval: unknown }>) {
  if ('click' in item) return page.locator(item.click).click({ timeout: stateMs })
  if ('fill' in item) return page.locator(item.fill[0]).fill(item.fill[1], { timeout: stateMs })
  if ('press' in item) return page.keyboard.press(item.press)
  if ('wait' in item) return page.waitForTimeout(item.wait)
  return page.evaluate(
    async ({ actionStep, timeoutMs }) => {
      const hook = (window as Window & { ultimate?: TestHook }).ultimate
      if (!hook) throw new Error('This page has no window.ultimate')
      if ('send' in actionStep) return hook.send(actionStep.send)
      if ('until' in actionStep) return hook.until(actionStep.until, { timeoutMs })
      if (actionStep.ui === 'snapshot') return hook.ui.snapshot()
      const result = await hook.ui.act({ steps: actionStep.steps })
      if (!result.ok) throw new Error(JSON.stringify(result))
      return result
    },
    { actionStep: item, timeoutMs: stateMs },
  )
}

async function fresh(browser: Browser, conversation = 1) {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  await page.addInitScript(() => sessionStorage.setItem('ultimate.driven', '1'))
  await page.goto(`${base}/?conversation=${conversation}`)
  await page.locator('[data-keep-warm]').waitFor()
  return { page, close: () => context.close() }
}

async function once(browser: Browser, calls: Call[], scenario: Scenario): Promise<Measured> {
  const measured = { calls: 0, steps: 0, screenshots: 0, ms: 0, sleepMs: 0, ok: true }
  let bytes = 0
  let imageBytes = 0
  let imageTokens = 0
  await scenario.ready?.()
  const conversation = scenario.freshConversation
    ? (await post<{ id: number }>('/api/conversations', {})).id
    : 1
  try {
    for (const [callIndex, call] of calls.entries()) {
      const { page, close } = await fresh(browser, conversation)
      try {
        const final = callIndex === calls.length - 1
        const before = (final ? await scenario.before?.(page) : null) ?? null
        const started = performance.now()
        measured.calls++
        const outcomes: string[] = []
        let read: string | null = null
        try {
          for (const [index, item] of call.steps.entries()) {
            measured.steps++
            if ('wait' in item) measured.sleepMs += item.wait
            const value =
              'eval' in item ? (read = await page.evaluate(item.eval)) : await step(page, item)
            outcomes.push(
              `Step ${index + 1}: OK${value === undefined ? '' : ` ${JSON.stringify(value)}`}`,
            )
          }
          if (call.screenshot) {
            const png = await page.screenshot({ type: 'png' })
            measured.screenshots++
            imageBytes += png.length
            imageTokens += (viewport.width * viewport.height) / pixelsPerImageToken
          }
        } catch (error) {
          console.error(error)
          outcomes.push(String(error))
          measured.ok = false
        }
        bytes += Buffer.byteLength(outcomes.join('\n'))
        measured.ms += performance.now() - started
        if (!measured.ok) break
        if (final) measured.ok = await scenario.done(page, read, before)
      } finally {
        await close()
      }
    }
  } finally {
    await scenario.restore?.()
  }
  return {
    ...measured,
    kb: Math.round((bytes + imageBytes) / 1024),
    tokens: Math.round(bytes / bytesPerToken + imageTokens),
    ms: Math.round(measured.ms),
  }
}

const summary = (list: Measured[]): Measured => ({
  calls: median(list.map((item) => item.calls)),
  steps: median(list.map((item) => item.steps)),
  screenshots: median(list.map((item) => item.screenshots)),
  kb: median(list.map((item) => item.kb)),
  tokens: median(list.map((item) => item.tokens)),
  ms: median(list.map((item) => item.ms)),
  sleepMs: median(list.map((item) => item.sleepMs)),
  ok: list.every((item) => item.ok),
})

const browser = await chromium.launch({ executablePath: await browserBinary() })
const out: Record<string, { selectors: Measured; ui: Measured | null }> = {}
try {
  const probe = await fresh(browser)
  const hasUi = await probe.page.evaluate(
    () => !!(window as Window & { ultimate?: TestHook }).ultimate?.ui,
  )
  await probe.close()
  for (const [name, scenario] of Object.entries(scenarios)) {
    const style = async (kind: 'selectors' | 'ui') => {
      const list: Measured[] = []
      for (let index = 0; index < runs; index++)
        list.push(await once(browser, scenario[kind], scenario))
      console.error(`${name} (${kind}): ${JSON.stringify(list)}`)
      return summary(list)
    }
    out[name] = {
      selectors: await style('selectors'),
      ui: hasUi ? await style('ui') : null,
    }
  }
} finally {
  await browser.close()
}
console.log(JSON.stringify(out))
