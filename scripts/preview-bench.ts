import { chromium } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
import { browserBinary } from '../extensions/browser/server.ts'
import { meansNone } from '../lib/errors.ts'

type Step =
  | { click: string }
  | { press: string }
  | { eval: string }
  | { ui: 'snapshot' }
  | { ui: 'act'; steps: { ref: string; action: string; args?: unknown[] }[] }
type Call = { steps: Step[]; screenshot: boolean }
type Scenario = {
  selectors: Call[]
  ui: Call[]
  check: (page: Page, results: unknown[]) => Promise<boolean>
  reset?: (page: Page) => Promise<void>
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

const [base] = process.argv.slice(2)
if (!base) throw new Error('Usage: node scripts/preview-bench.ts <url> [--runs 3]')
const runs = Number(process.argv[process.argv.indexOf('--runs') + 1] || 3)
const viewport = { width: 1440, height: 900 }
const bytesPerToken = 4
const pixelsPerImageToken = 750

const pauseTrigger = '[data-pause]'
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
    check: async (page) =>
      (await warmSwitch(page).then((toggle) => toggle.getAttribute('aria-checked'))) === 'false',
    reset: async (page) => {
      await (await warmSwitch(page)).click()
    },
  },
  pause: {
    selectors: [
      { steps: [], screenshot: true },
      {
        steps: [{ click: pauseTrigger }, { click: `:is(${popover}) button:has-text("Pause")` }],
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
    check: (page) =>
      page.waitForSelector('[data-pause="paused"]', { timeout: 5000 }).then(() => true),
    reset: async (page) => {
      if (!(await page.locator(`:is(${popover})`).isVisible()))
        await page.locator(pauseTrigger).click()
      await page.locator(`:is(${popover}) button:has-text("Play") >> nth=-1`).click()
      await page.waitForSelector('[data-pause]:not([data-pause="paused"])')
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
    check: async (page) => (await page.locator(`:is(${popover})`).innerText()).includes('Decide'),
  },
}

async function warmSwitch(page: Page) {
  const toggle = page.locator(`:is(${popover}) [role="switch"]`)
  if (!(await toggle.isVisible())) await page.locator('[data-keep-warm]').click()
  return toggle
}

async function step(page: Page, item: Step) {
  if ('click' in item) return page.locator(item.click).click({ timeout: 10_000 })
  if ('press' in item) return page.keyboard.press(item.press)
  if ('eval' in item) return page.evaluate(item.eval)
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
  await page.waitForFunction(() => 'ultimate' in window)
  await page.locator('[data-keep-warm]').waitFor()
  return { page, close: () => context.close() }
}

async function once(browser: Browser, calls: Call[], scenario: Scenario): Promise<Measured> {
  const measured = { calls: 0, steps: 0, screenshots: 0, kb: 0, tokens: 0, ms: 0, ok: true }
  const results: unknown[] = []
  let bytes = 0
  let imageBytes = 0
  let imageTokens = 0
  let page: Page | undefined
  for (const call of calls) {
    const opened = await fresh(browser)
    page = opened.page
    const started = performance.now()
    measured.calls++
    const outcomes: string[] = []
    try {
      for (const item of call.steps) {
        measured.steps++
        const value = await step(page, item)
        results.push(value)
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
    if (!measured.ok) {
      await opened.close()
      break
    }
    if (call !== calls.at(-1)) await opened.close()
    else {
      measured.ok = (await scenario.check(page, results).catch(meansNone)) ?? false
      await scenario.reset?.(page)
      await opened.close()
    }
  }
  return {
    ...measured,
    kb: Math.round((bytes + imageBytes) / 1024),
    tokens: Math.round(bytes / bytesPerToken + imageTokens),
    ms: Math.round(measured.ms),
  }
}

const median = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) / 2)]
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
