import { access, mkdir, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { arr, bool, int, lit, map, obj, opt, str, union, unknown } from '@earendil-works/pi-schema'
import { strEnum } from '../../lib/schema.ts'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { fitImage } from '@earendil-works/pi-durable/images/fit'
import { DEFAULT_IMAGE_LIMITS, type ImageProcessor } from '@earendil-works/pi-durable/tools'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { groupTarget, identify } from '../../lib/process-group.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { fetchAssets, sourceFrames } from '../../lib/source-frames.shared.ts'
import { watchSteer } from '../../lib/steer.ts'
import { within as withinDeadline } from '../../lib/timers.shared.ts'
import { safeToRerun } from '../../lib/replay.ts'
import { errnoCode, inProcess, ignoring, meansNone } from '../../lib/errors.shared.ts'
import type { TestHook } from '../../web/src/sdk/test-hook.ts'

declare global {
  interface Window {
    ultimate?: TestHook
  }
}

export async function playwrightChromiums(
  home: string,
  platform = process.platform,
  arch = process.arch,
) {
  const [cache, executables] =
    platform === 'darwin'
      ? [
          join(home, 'Library/Caches/ms-playwright'),
          [
            `chrome-mac-${arch}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
            'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
          ],
        ]
      : [join(home, '.cache/ms-playwright'), ['chrome-linux64/chrome']]
  return (await readdir(cache).catch(() => []))
    .filter((name) => name.startsWith('chromium-'))
    .toSorted((a, b) => b.localeCompare(a, 'en', { numeric: true }))
    .flatMap((name) => executables.map((executable) => join(cache, name, executable)))
}

export async function browserBinary() {
  const candidates = [
    process.env.ULTIMATE_CHROMIUM,
    '/usr/bin/chromium',
    '/usr/bin/google-chrome-stable',
    ...(await playwrightChromiums(homedir())),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter((path): path is string => !!path)
  for (const path of candidates) {
    const available = await access(path)
      .then(() => path)
      .catch(meansNone)
    if (available) return available
  }
  throw new Error(
    'No Chromium found. Set ULTIMATE_CHROMIUM, install /usr/bin/chromium or /usr/bin/google-chrome-stable (Google Chrome in /Applications on macOS), or run `npx playwright install chromium` (~/.cache/ms-playwright on Linux, ~/Library/Caches/ms-playwright on macOS).',
  )
}

export function screenshotFile(home: string, cwd: string, path?: string) {
  if (path === undefined) return join(home, 'screenshots', `${Date.now()}-${randomUUID()}.png`)
  if (!path.endsWith('.png'))
    throw new Error(
      `path is where the PNG is saved and must end in .png, not ${JSON.stringify(path)}; pass the page to load as url, such as / (it opens @ultimate).`,
    )
  return resolve(cwd, path)
}

const stepTimeoutMs = 30_000
const untilTimeoutMs = 10_000
const maxUntilTimeoutMs = 120_000
const closeTimeoutMs = 5_000

function timeout(ms: number) {
  return Object.assign(new Error(`timed out after ${ms / 1000}s`), { name: 'TimeoutError' })
}

function within<T>(ms: number, work: Promise<T>, error = timeout(ms)) {
  return withinDeadline(ms, work, () => error)
}

async function browserProcess(browser: Browser) {
  const cdp = await browser.newBrowserCDPSession()
  const { processInfo } = (await cdp.send('SystemInfo.getProcessInfo')) as {
    processInfo: { type: string; id: number }[]
  }
  await cdp.detach()
  const pid = processInfo.find((info) => info.type === 'browser')?.id
  const start = pid === undefined ? undefined : identify(pid)
  return pid === undefined || start === undefined ? undefined : { pid, start }
}

const gone = (error: unknown) => ['ESRCH', 'EPERM'].includes(errnoCode(error) ?? '')

function killDisconnectedBrowserGroup(owner: { pid: number; start: string } | undefined) {
  if (!owner || identify(owner.pid) !== owner.start) return
  const target = groupTarget(owner.pid)
  try {
    process.kill(target, 'SIGKILL')
  } catch (error) {
    ignoring(gone)(error)
  }
}

async function namingMatches(page: Page, selector: string, error: unknown): Promise<never> {
  if (!String(error).includes('strict mode violation')) throw error
  const matches = page.locator(selector)
  const count = await matches.count()
  const shown = await Promise.all(
    Array.from({ length: Math.min(count, 5) }, (_, index) =>
      matches
        .nth(index)
        .ariaSnapshot()
        .then((snapshot) => snapshot.split('\n')[0].replace(/^- /, '').slice(0, 120)),
    ),
  )
  throw new Error(
    [
      `${JSON.stringify(selector)} matches ${count} elements; a step needs exactly one. Scope it to one card or panel ('[data-entry-id="42"] button:has-text("Retry")'), or find the control with a ui query step. The matches:`,
      ...shown.map((match, index) => `  ${index + 1}) ${match}`),
      ...(count > shown.length ? [`  … and ${count - shown.length} more`] : []),
    ].join('\n'),
  )
}

function waitForCompositorSurface(page: Page) {
  return page.evaluate(
    () =>
      new Promise<void>((painted) =>
        requestAnimationFrame(() => requestAnimationFrame(() => painted())),
      ),
  )
}

async function capture(
  images: ImageProcessor,
  page: Page,
  file: string,
  selector?: string,
  fullPage = false,
) {
  await waitForCompositorSurface(page)
  await mkdir(dirname(file), { recursive: true })
  const target = selector ? page.locator(selector) : page
  const png = await target.screenshot({
    path: file,
    type: 'png',
    ...(selector ? {} : { fullPage }),
  })
  const fitted = await fitImage(
    new Uint8Array(png),
    'image/png',
    { ...DEFAULT_IMAGE_LIMITS, maxWidth: 1600, maxHeight: 1600 },
    images,
  )
  return fitted.kind === 'fitted'
    ? { file, image: fitted.image, note: fitted.notes.join(' ') }
    : { file, image: undefined, note: fitted.note }
}

export default function browserExtension(host: ExtensionHost) {
  const state = host.resource('browser', () => {
    const resource: { launched?: Promise<Browser>; browser?: Browser } = {}
    host.onClose(async () => {
      if (resource.launched) await (await resource.launched).close()
    })
    return resource
  })
  const base = {
    url: opt(str({ description: 'Page to load; relative URLs resolve against this UI.' })),
    path: opt(
      str({
        description:
          'Where to save the PNG, relative to your cwd; default: a new file in the home.',
      }),
    ),
    width: opt(
      int({
        minimum: 1,
        description: 'Viewport width in CSS pixels; default 1440, 375 for a phone.',
      }),
    ),
    height: opt(int({ minimum: 1, description: 'Viewport height in CSS pixels; default 900.' })),
    timeoutMs: opt(
      int({ minimum: 1, description: 'Limit per step, load and capture; default 30000.' }),
    ),
  }
  return defineExtension({
    name: 'browser',
    sections: [
      section(
        'visual_verification',
        () =>
          'After UI changes, use screenshot and look at the image before claiming success. Use browser to drive fresh pages and inspect errors. Omit url to see your own UI, or pass a relative url such as / (it opens @ultimate) or /?conversation=<id>; do not guess its port. Omit path: the PNG then goes to the home, outside your checkout, where a stray file would block landing; pass path: `<file>.png` only for a screenshot you commit. Pass an instance URL to test another server.',
      ),
    ],
    tools: [
      defineTool({
        name: 'screenshot',
        description:
          'Look at a browser page; save a full-resolution PNG and return a compact image with loading errors. Loading and capturing each time out after 30 s.',
        ...safeToRerun(
          'a rerun loads the page again and writes one more PNG; it clicks and types nothing',
        ),
        parameters: obj({
          ...base,
          fullPage: opt(bool()),
          selector: opt(str()),
          waitMs: opt(int({ minimum: 0 })),
          theme: opt(strEnum(['light', 'dark'])),
        }),
        async execute(args, api, context) {
          const waitMs = args.waitMs ?? 1500
          return run(args, waitMs, api, context, async (page, _outcomes, png, guard) => {
            await guard(page.waitForTimeout(waitMs), waitMs)
            return guard(capture(host.images, page, png, args.selector, args.fullPage))
          })
        },
      }),
      defineTool({
        name: 'browser',
        description:
          "Drive a fresh browser page and report each step's outcome, then an image unless screenshot: false. Each step times out after 30 s. On an Ultimate page (this UI or a preview) every control is a ui-sdk component: drive it with `ui` steps, not selectors. {ui: 'query', text} finds controls by label or row text, with their ref, state and actions; {ui: 'act', steps: [{ref, action, args?}]} runs actions as the agent (ref: the exact label or a ref) and returns what changed and what appeared, like [{ref: 'System', action: 'press'}] to switch surface or [{ref: 'Keep warm', action: 'setChecked', args: [false]}]; {ui: 'snapshot'} lists the page's controls (long pages stop at 100: prefer query). `send` submits a prompt and `until` waits on state, never a guessed time: 'idle' (that conversation's turn is done), 'quiet' (nothing is busy, branches and subagents included), {entry: kind}, {event: name, where} or {ui: label, is: {checked: false}} (that control has that state; is omitted: it is on the page); until fails after 10 s and says what it saw: a control, a state or an event that takes longer is a bug to report. Only waiting on a model turn ('idle', 'quiet' or {entry: 'assistant'} after a send) passes a longer timeoutMs, at most 120000. eval is not for waiting: no setTimeout sleeps in it; use until. click, fill, press and a selector wait are for testing the interaction itself or pages without ui-sdk; scope them to one card or panel ('[data-entry-id=\"42\"] button:has-text(\"Retry\")'). eval reads what no control holds: transcript text, layout, styles.",
        parameters: obj({
          ...base,
          steps: arr(
            union([
              obj({ click: str() }),
              obj({
                fill: arr(str(), {
                  minItems: 2,
                  maxItems: 2,
                  description: '[selector, value]',
                }),
              }),
              obj({ press: str() }),
              obj({ wait: str({ description: 'A selector to wait for.' }) }),
              obj({
                eval: str({
                  description:
                    "One expression, its value returned: 'document.title'. For statements or await, an async IIFE: '(async () => { const r = await fetch(\"/api/x\"); return r.status })()'. A bare 'const x = …; return x' fails.",
                }),
              }),
              obj({
                send: str(),
                conversation: opt(int({ minimum: 1 })),
              }),
              obj({ ui: lit('snapshot') }),
              obj({
                ui: lit('query'),
                text: opt(str()),
                within: opt(str({ description: 'A list component whose items to return.' })),
                kind: opt(str({ description: 'One component kind, like select.' })),
              }),
              obj({
                ui: lit('act'),
                steps: arr(
                  obj({
                    ref: str({ description: 'A ref from snapshot, or the label.' }),
                    action: str({ description: 'One of the component’s actions.' }),
                    args: opt(arr(unknown())),
                  }),
                  { minItems: 1 },
                ),
              }),
              obj({
                until: union([
                  lit('idle'),
                  lit('quiet'),
                  obj({ entry: str() }),
                  obj({
                    event: str(),
                    where: opt(map(unknown())),
                  }),
                  obj({
                    ui: str({ description: 'A control’s exact label or ref.' }),
                    is: opt(
                      map(unknown(), { description: 'State it must have, like {open: true}.' }),
                    ),
                  }),
                ]),
                conversation: opt(int({ minimum: 1 })),
                timeoutMs: opt(int({ minimum: 1, maximum: maxUntilTimeoutMs })),
              }),
            ]),
          ),
          screenshot: opt(bool()),
        }),
        async execute(args, api, context) {
          const waits = args.steps.reduce(
            (sum, step) => sum + ('until' in step ? (step.timeoutMs ?? untilTimeoutMs) : 0),
            0,
          )
          return run(args, waits, api, context, async (page, outcomes, png, guard) => {
            const ultimateControlsMounted = () =>
              guard(
                page
                  .waitForFunction(
                    () =>
                      !document.querySelector('meta[name=ultimate-web]') || !!window.ultimate?.ui,
                  )
                  .then(() =>
                    page.evaluate(() =>
                      document.querySelector('meta[name=ultimate-web]')
                        ? window.ultimate!.ui.ready()
                        : undefined,
                    ),
                  ),
              )
            for (const [index, step] of args.steps.entries()) {
              context.abortSignal?.throwIfAborted()
              api.output(`Step ${index + 1}: ${JSON.stringify(step)}\n`)
              try {
                let value: unknown
                if ('click' in step || 'fill' in step || 'press' in step)
                  await ultimateControlsMounted()
                const one = (selector: string, work: Promise<void>) =>
                  guard(work.catch((error: unknown) => namingMatches(page, selector, error)))
                if ('click' in step) await one(step.click, page.locator(step.click).click())
                else if ('fill' in step)
                  await one(step.fill[0], page.locator(step.fill[0]).fill(step.fill[1]))
                else if ('press' in step) await guard(page.keyboard.press(step.press))
                else if ('wait' in step) await one(step.wait, page.locator(step.wait).waitFor())
                else if ('send' in step || 'until' in step || 'ui' in step) {
                  const waitForLoadedSdk = () =>
                    guard(
                      page
                        .waitForFunction(() => 'ultimate' in window)
                        .catch(() => {
                          throw new Error(
                            'This page has no window.ultimate: not an Ultimate UI, or one older than send/until steps',
                          )
                        }),
                    )
                  await waitForLoadedSdk()
                  if ('ui' in step) {
                    const outcome = await guard(
                      page.evaluate((uiStep) => {
                        const ui = window.ultimate!.ui
                        if (!ui)
                          return {
                            error:
                              'This page has no window.ultimate.ui: an Ultimate UI older than ui steps',
                          }
                        const work =
                          uiStep.ui === 'snapshot'
                            ? ui.snapshot()
                            : uiStep.ui === 'query'
                              ? ui.query({
                                  text: uiStep.text,
                                  within: uiStep.within,
                                  kind: uiStep.kind,
                                })
                              : ui.act({ steps: uiStep.steps }).then((result) => {
                                  if (result.ok) return result
                                  const failed = result.error?.step ?? 0
                                  const { ref, action } = uiStep.steps[failed] ?? {}
                                  throw new Error(
                                    `act step ${failed + 1} (${ref} ${action}) failed: ${result.error?.message ?? 'no reason given'}`,
                                  )
                                })
                        return work.then(
                          (result: unknown) => ({ result }),
                          (error: unknown) => ({ error: String(error) }),
                        )
                      }, step),
                    )
                    if ('error' in outcome) throw new Error(outcome.error.replace(/^Error: /, ''))
                    value = outcome.result
                  } else if ('send' in step)
                    value = await guard(
                      page.evaluate(
                        ([text, conversation]) =>
                          window.ultimate!.send(text, { conversation: conversation ?? undefined }),
                        [step.send, step.conversation ?? null] as const,
                      ),
                    )
                  else {
                    const ms = step.timeoutMs ?? untilTimeoutMs
                    const end = Date.now() + ms
                    const waitWithoutResending = () =>
                      guard(
                        page.evaluate(
                          ([condition, conversation, timeoutMs]) =>
                            window
                              .ultimate!.until(condition, {
                                conversation: conversation ?? undefined,
                                timeoutMs,
                              })
                              .then(
                                (result) => ({ result }),
                                (error: unknown) => ({ error: String(error) }),
                              ),
                          [
                            step.until,
                            step.conversation ?? null,
                            Math.max(1, end - Date.now()),
                          ] as const,
                        ),
                        ms,
                      )
                    const { promise: steered, resolve: steer } = Promise.withResolvers<'steered'>()
                    const stopSteer = await watchSteer(api, context, () => steer('steered'))
                    const started = Date.now()
                    let outcome: Awaited<ReturnType<typeof waitWithoutResending>> | 'steered'
                    try {
                      for (;;) {
                        try {
                          outcome = await Promise.race([waitWithoutResending(), steered])
                          break
                        } catch (error) {
                          const pageReloadDestroyedWait = String(error).includes(
                            'Execution context was destroyed',
                          )
                          if (!pageReloadDestroyedWait) throw error
                          context.abortSignal?.throwIfAborted()
                          api.output('The page reloaded; waiting again\n')
                          await waitForLoadedSdk()
                        }
                      }
                    } finally {
                      await stopSteer()
                    }
                    if (outcome === 'steered') {
                      outcomes.push(
                        `Step ${index + 1}: interrupted by a steering message after ${Math.round((Date.now() - started) / 1000)}s; later steps did not run`,
                      )
                      return undefined
                    }
                    if ('error' in outcome) throw new Error(outcome.error.replace(/^Error: /, ''))
                    value = outcome.result
                  }
                } else value = await guard(page.evaluate(step.eval))
                outcomes.push(
                  `Step ${index + 1}: OK${value === undefined ? '' : ` ${JSON.stringify(value)}`}`,
                )
              } catch (error) {
                outcomes.push(`Step ${index + 1}: ${String(error)}`)
                throw error
              }
            }
            return args.screenshot === false ? undefined : guard(capture(host.images, page, png))
          })
        },
      }),
    ].map((tool) => ({ ...tool, structuredOutputSchema: { type: 'object' } })),
  })
  async function run(
    args: {
      url?: string
      path?: string
      width?: number
      height?: number
      theme?: 'light' | 'dark'
      timeoutMs?: number
    },
    waits: number,
    api: { output(text: string): void; env?: { cwd: string } },
    context: { abortSignal?: AbortSignal },
    action: (
      page: Page,
      outcomes: string[],
      png: string,
      guard: <T>(work: Promise<T>, extraMs?: number) => Promise<T>,
    ) => Promise<
      | {
          image?: { type: 'image'; mimeType: string; data: string }
          file: string
          note?: string
        }
      | undefined
    >,
  ) {
    const outcomes: string[] = []
    let isolated: BrowserContext | undefined
    let page: Page | undefined
    const stepMs = args.timeoutMs ?? stepTimeoutMs
    const coldLaunchAndPageSetupMs = Math.max(stepMs, stepTimeoutMs)
    const totalMs = 4 * stepMs + waits
    let deadline = Infinity
    const guard = <T>(work: Promise<T>, extraMs = 0) => {
      const left = deadline - Date.now()
      return left < stepMs + extraMs
        ? within(left, work, timeout(totalMs))
        : within(stepMs + extraMs, work)
    }
    const sendUnsavedUiState = (shown: Page) =>
      guard(
        shown.evaluate(() =>
          document.querySelector('meta[name=ultimate-web]')
            ? window.ultimate?.ui.flush()
            : undefined,
        ),
      ).then(
        () => [],
        (error: unknown) => [`The page's last UI-state writes were not sent: ${String(error)}`],
      )
    const abort = () => void closeContextOrRelaunchBrowser(isolated)
    try {
      const png = screenshotFile(host.home, api.env?.cwd ?? host.projectRoot, args.path)
      context.abortSignal?.throwIfAborted()
      if (!state.launched) {
        const launched: Promise<Browser> = browserBinary()
          .then(async (executablePath) => {
            const shortSingletonSocketEnvironment = { ...process.env, TMPDIR: undefined }
            const browser = await chromium.launch({
              executablePath,
              headless: true,
              chromiumSandbox: process.env.ULTIMATE_CHROMIUM_SANDBOX !== '0',
              env: shortSingletonSocketEnvironment,
            })
            if (state.launched === launched) state.browser = browser
            const owner = browserProcess(browser).catch(meansNone)
            browser.once('disconnected', () => {
              if (state.launched === launched) {
                state.launched = undefined
                state.browser = undefined
              }
              inProcess(
                'the disconnected browser was launched by this process',
                owner
                  .then(killDisconnectedBrowserGroup)
                  .catch((error: unknown) =>
                    host.notice(`Killing a disconnected browser failed: ${String(error)}`),
                  ),
              )
            })
            return browser
          })
          .catch((error) => {
            if (state.launched === launched) state.launched = undefined
            throw error
          })
        state.launched = launched
      }
      const browser = await within(coldLaunchAndPageSetupMs, state.launched)
      context.abortSignal?.throwIfAborted()
      isolated = await within(
        coldLaunchAndPageSetupMs,
        browser.newContext({
          viewport: { width: args.width ?? 1440, height: args.height ?? 900 },
          colorScheme: args.theme,
        }),
      )
      context.abortSignal?.addEventListener('abort', abort, { once: true })
      page = await within(coldLaunchAndPageSetupMs, isolated.newPage())
      deadline = Date.now() + totalMs
      page.setDefaultTimeout(stepMs)
      page.setDefaultNavigationTimeout(stepMs)
      context.abortSignal?.throwIfAborted()
      page.on('console', (message) => {
        if (message.type() === 'error') outcomes.push(`Console error: ${message.text()}`)
      })
      page.on('pageerror', (error) => outcomes.push(`Page error: ${error.message}`))
      const url = new URL(args.url ?? '', host.system().process.url).href
      await guard(
        page.addInitScript(() => {
          if (origin !== 'null') sessionStorage.setItem('ultimate.driven', '1')
        }),
      )
      if (new URL(url).origin === new URL(host.system().process.url).origin) {
        await guard(
          page.addInitScript((theme: string | undefined) => {
            sessionStorage.setItem('ultimate.detached', '1')
            if (theme) localStorage.setItem('ultimate.theme', theme)
          }, args.theme),
        )
      }
      api.output(`Loading ${url}\n`)
      await guard(page.goto(url, { waitUntil: 'domcontentloaded' }))
      const result = await action(page, outcomes, png, guard)
      outcomes.push(...(await sendUnsavedUiState(page)))
      const title = await guard(page.title())
      const maps = new Map()
      const readFromRedirectedOrigin = fetchAssets(new URL(page.url()).origin)
      outcomes.splice(
        0,
        outcomes.length,
        ...(await guard(
          Promise.all(
            outcomes.map((outcome) => sourceFrames(outcome, readFromRedirectedOrigin, maps)),
          ),
        )),
      )
      context.abortSignal?.throwIfAborted()
      return {
        structuredOutput: {
          title,
          ...(result
            ? {
                ...(result.image
                  ? { image: `data:${result.image.mimeType};base64,${result.image.data}` }
                  : {}),
                file: result.file,
              }
            : {}),
          outcomes,
        },
        output: [
          ...(result?.note ? [{ type: 'text' as const, text: result.note }] : []),
          ...(result?.image ? [result.image] : []),
          {
            type: 'text' as const,
            text: [`Title: ${title}`, ...(result ? [`PNG: ${result.file}`] : []), ...outcomes].join(
              '\n',
            ),
          },
        ],
      }
    } catch (error) {
      const notSent = page && !context.abortSignal?.aborted ? await sendUnsavedUiState(page) : []
      return {
        isError: true,
        output: [
          { type: 'text' as const, text: [String(error), ...outcomes, ...notSent].join('\n') },
        ],
      }
    } finally {
      context.abortSignal?.removeEventListener('abort', abort)
      await closeContextOrRelaunchBrowser(isolated)
    }
  }

  async function closeContextOrRelaunchBrowser(isolated: BrowserContext | undefined) {
    if (!isolated) return
    try {
      await within(closeTimeoutMs, isolated.close())
    } catch (error) {
      const browser = isolated.browser()
      if (!browser?.isConnected()) return
      host.notice(`Closing a browser context failed (${String(error)}); relaunching the browser.`)
      if (state.browser === browser) {
        state.launched = undefined
        state.browser = undefined
      }
      await within(closeTimeoutMs, browser.close()).catch((reason: unknown) =>
        host.notice(`Closing the wedged browser failed: ${String(reason)}`),
      )
    }
  }
}
