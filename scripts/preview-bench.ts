import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
import { browserBinary } from '../extensions/browser/server.ts'
import { SetAction, StateAction as WarmStateAction } from '../extensions/keep-warm/refs.ts'
import { PlayAction, StateAction as PauseStateAction } from '../extensions/pause/refs.ts'
import { meansNone } from '../lib/errors.ts'
import type { ActionRef } from '../shared/extension-api.ts'
import { median, runsFlag } from './measure.ts'

type Step =
  | { click: string }
  | { ui: 'snapshot' }
  | { ui: 'act'; steps: { ref: string; action: string; args?: unknown[] }[] }
type Call = { steps: Step[]; screenshot: boolean }
type Scenario = {
  selectors: Call[]
  ui: Call[]
  done: (page: Page) => Promise<unknown>
  ready: () => Promise<void>
  restore: () => Promise<unknown>
}
export type Measured = {
  calls: number
  steps: number
  screenshots: number
  kb: number
  tokens: number
  ms: number
  ok: boolean
}

const home = process.argv[2]
if (!home) throw new Error('Usage: node scripts/preview-bench.ts <scratch home> [--runs 3]')
const base = (await readFile(join(home, 'benchmark-host'), 'utf8')).trim()
const runs = runsFlag(process.argv)
const viewport = { width: 1440, height: 900 }
const bytesPerToken = 4
const pixelsPerImageToken = 750
const stateMs = 5000

const action = async <Args, Result>(ref: ActionRef<Args, Result>, args: Args) => {
  const response = await fetch(`${base}/api/extensions/${ref.extension}/actions/${ref.name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ args }),
  })
  if (!response.ok) throw new Error(`${ref.extension}.${ref.name}: ${await response.text()}`)
  return ((await response.json()) as { result: Result }).result
}
const expect = async (holds: Promise<boolean>, what: string) => {
  if (!(await holds)) throw new Error(`Benchmark needs ${what} before it starts`)
}

const popover = '[data-slot="popover-content"], [role="dialog"]'
const scenarios: Record<string, Scenario> = {
  'keep-warm': {
    selectors: [
      { steps: [], screenshot: true },
      {
        steps: [{ click: '[data-keep-warm]' }, { click: `:is(${popover}) [role="switch"]` }],
        screenshot: true,
      },
    ],
    ui: [
      { steps: [{ ui: 'snapshot' }], screenshot: false },
      {
        steps: [
          {
            ui: 'act',
            steps: [
              { ref: "Keep @ultimate's cache warm", action: 'setOpen', args: [true] },
              { ref: 'Keep @ultimate warm', action: 'setChecked', args: [false] },
            ],
          },
        ],
        screenshot: false,
      },
    ],
    done: (page) =>
      page.waitForSelector(`:is(${popover}) [role="switch"][aria-checked="false"]`, {
        timeout: stateMs,
      }),
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
      { steps: [], screenshot: true },
      {
        steps: [{ click: '[data-pause]' }, { click: `:is(${popover}) button:has-text("Pause")` }],
        screenshot: true,
      },
    ],
    ui: [
      { steps: [{ ui: 'snapshot' }], screenshot: false },
      {
        steps: [
          {
            ui: 'act',
            steps: [
              { ref: 'Pause or continue all work', action: 'setOpen', args: [true] },
              { ref: 'Pause: stop starting new work', action: 'press' },
            ],
          },
        ],
        screenshot: false,
      },
    ],
    done: (page) => page.waitForSelector('[data-pause="paused"]', { timeout: stateMs }),
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
    selectors: [
      { steps: [], screenshot: true },
      { steps: [{ click: '[data-setup-issues]' }], screenshot: true },
    ],
    ui: [
      { steps: [{ ui: 'snapshot' }], screenshot: false },
      {
        steps: [{ ui: 'act', steps: [{ ref: '1 setup issue', action: 'setOpen', args: [true] }] }],
        screenshot: false,
      },
    ],
    done: (page) => page.waitForSelector(`:is(${popover}) :text("Decide")`, { timeout: stateMs }),
    ready: async () => undefined,
    restore: async () => undefined,
  },
}

async function step(page: Page, item: Step) {
  if ('click' in item) return page.locator(item.click).click({ timeout: 10_000 })
  return page.evaluate(async (uiStep) => {
    const ui = (
      window as unknown as { ultimate?: { ui?: Record<string, (a?: unknown) => unknown> } }
    ).ultimate?.ui
    if (!ui) throw new Error('This page has no window.ultimate.ui')
    return uiStep.ui === 'snapshot' ? ui.snapshot() : ui.act({ steps: uiStep.steps })
  }, item)
}

async function fresh(browser: Browser) {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  await page.addInitScript(() => sessionStorage.setItem('ultimate.driven', '1'))
  await page.goto(`${base}/?conversation=1`)
  await page.locator('[data-keep-warm]').waitFor()
  return { page, close: () => context.close() }
}

async function once(browser: Browser, calls: Call[], scenario: Scenario): Promise<Measured> {
  const measured = { calls: 0, steps: 0, screenshots: 0, ms: 0, ok: true }
  let bytes = 0
  let imageBytes = 0
  let imageTokens = 0
  let acted = false
  await scenario.ready()
  try {
    for (const [index, call] of calls.entries()) {
      const { page, close } = await fresh(browser)
      try {
        const started = performance.now()
        measured.calls++
        const outcomes: string[] = []
        try {
          for (const item of call.steps) {
            measured.steps++
            acted ||= 'click' in item || item.ui === 'act'
            const value = await step(page, item)
            outcomes.push(
              `Step ${measured.steps}: OK${value === undefined ? '' : ` ${JSON.stringify(value)}`}`,
            )
          }
          if (call.screenshot) {
            const png = await page.screenshot({ type: 'png' })
            measured.screenshots++
            imageBytes += png.length
            imageTokens += (viewport.width * viewport.height) / pixelsPerImageToken
          }
        } catch (error) {
          outcomes.push(String(error))
          measured.ok = false
        }
        bytes += Buffer.byteLength(outcomes.join('\n'))
        measured.ms += performance.now() - started
        if (!measured.ok) break
        if (index === calls.length - 1)
          measured.ok = (await scenario.done(page).then(() => true, meansNone)) ?? false
      } finally {
        await close()
      }
    }
  } finally {
    if (acted) await scenario.restore()
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
  ok: list.every((item) => item.ok),
})

const browser = await chromium.launch({ executablePath: await browserBinary() })
const out: Record<string, { selectors: Measured; ui: Measured | null }> = {}
try {
  const probe = await fresh(browser)
  const hasUi = await probe.page.evaluate(
    () => !!(window as unknown as { ultimate?: { ui?: unknown } }).ultimate?.ui,
  )
  await probe.close()
  for (const [name, scenario] of Object.entries(scenarios)) {
    const style = async (calls: Call[]) => {
      const list: Measured[] = []
      for (let index = 0; index < runs; index++) list.push(await once(browser, calls, scenario))
      console.error(`${name}: ${JSON.stringify(list)}`)
      return summary(list)
    }
    out[name] = {
      selectors: await style(scenario.selectors),
      ui: hasUi ? await style(scenario.ui) : null,
    }
  }
} finally {
  await browser.close()
}
console.log(JSON.stringify(out))
