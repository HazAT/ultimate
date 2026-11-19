import { chromium } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
import { browserBinary } from '../extensions/browser/server.ts'
import { meansNone } from '../lib/errors.ts'
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
  restore: (base: string) => Promise<unknown>
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

const base = process.argv[2]
if (!base?.startsWith('http'))
  throw new Error('Usage: node scripts/preview-bench.ts <url> [--runs 3]')
const runs = runsFlag(process.argv)
const viewport = { width: 1440, height: 900 }
const bytesPerToken = 4
const pixelsPerImageToken = 750
const stateMs = 5000

const action = (extension: string, name: string, args: unknown) =>
  fetch(`${base}/api/extensions/${extension}/actions/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ args }),
  }).then(async (response) => {
    if (!response.ok) throw new Error(`${extension}.${name}: ${await response.text()}`)
  })

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
    restore: () => action('keep-warm', 'set', { on: true }),
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
    restore: () => action('pause', 'play', null),
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
    await scenario.restore(base)
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
