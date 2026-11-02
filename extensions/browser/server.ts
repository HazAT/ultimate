import { access, mkdir, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  arr,
  bool,
  int,
  lit,
  map,
  num,
  obj,
  oneOf,
  opt,
  str,
  union,
  unknown,
} from '@earendil-works/pi-schema'
import { formatDimensionNote, resizeImage } from '@earendil-works/pi-coding-agent'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import type { ExtensionHost } from '../../server/extensions.ts'

/** Chromium executables Playwright may have installed under `home` for `platform`, newest first. */
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
            // Older Playwright releases installed their own Chromium build.
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
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ...(await playwrightChromiums(homedir())),
  ].filter((path): path is string => !!path)
  for (const path of candidates) {
    try {
      await access(path)
      return path
    } catch {
      /* try the next installed browser */
    }
  }
  throw new Error(
    'No Chromium found. Set ULTIMATE_CHROMIUM, install /usr/bin/chromium or /usr/bin/google-chrome-stable (Google Chrome in /Applications on macOS), or run `npx playwright install chromium` (~/.cache/ms-playwright on Linux, ~/Library/Caches/ms-playwright on macOS).',
  )
}

/** The PNG's absolute path: `path` against the conversation's cwd, else a new file in the home's screenshots. */
export function screenshotFile(home: string, cwd: string, path?: string) {
  if (path === undefined) return join(home, 'screenshots', `${Date.now()}-${randomUUID()}.png`)
  if (!path.endsWith('.png'))
    throw new Error(
      `path is where the PNG is saved and must end in .png, not ${JSON.stringify(path)}; pass the page to load as url, such as / (it opens @ultimate).`,
    )
  return resolve(cwd, path)
}

/** Each page operation's limit unless a call passes timeoutMs; a call as a whole gets four of them plus its explicit waits. */
const stepTimeoutMs = 30_000
/** How long an `until` step waits on Ultimate's state unless it passes timeoutMs. */
const untilTimeoutMs = 300_000
/** How long closing a context, or the browser after it, may take before it counts as wedged. */
const closeTimeoutMs = 5_000

function timeout(ms: number) {
  return Object.assign(new Error(`timed out after ${ms / 1000}s`), { name: 'TimeoutError' })
}

/** `work`, unless `ms` pass first; a promise Playwright never settles (evaluate has no timeout) cannot hang the call. */
function within<T>(ms: number, work: Promise<T>, error = timeout(ms)) {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(error), Math.max(0, ms))
    }),
  ]).finally(() => clearTimeout(timer))
}

async function capture(page: Page, file: string, selector?: string, fullPage = false) {
  await mkdir(dirname(file), { recursive: true })
  const target = selector ? page.locator(selector) : page
  const png = await target.screenshot({
    path: file,
    type: 'png',
    ...(selector ? {} : { fullPage }),
  })
  const resized = await resizeImage(png, 'image/png', { maxWidth: 1600, maxHeight: 1600 })
  return {
    file,
    image: resized
      ? { type: 'image' as const, mimeType: resized.mimeType, data: resized.data }
      : undefined,
    note: resized
      ? formatDimensionNote(resized)
      : '[Image omitted: could not be resized below the inline image size limit.]',
  }
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
        // A fresh isolated page only observes the UI and writes the screenshot again; it performs no interactions.
        replay: 'safe',
        parameters: obj({
          ...base,
          width: opt(int({ minimum: 1 })),
          height: opt(int({ minimum: 1 })),
          fullPage: opt(bool()),
          selector: opt(str()),
          waitMs: opt(int({ minimum: 0 })),
          theme: opt(oneOf(['light', 'dark'])),
        }),
        async execute(args, api, context) {
          const waitMs = args.waitMs ?? 1500
          return run(args, waitMs, api, context, async (page, _outcomes, png, guard) => {
            await guard(page.waitForTimeout(waitMs), waitMs)
            return guard(capture(page, png, args.selector, args.fullPage))
          })
        },
      }),
      defineTool({
        name: 'browser',
        description:
          "Drive a fresh browser page with clicks, fills, keys, waits and JavaScript; report outcomes and optionally an image. Each step times out after 30 s. On an Ultimate page (this UI or a preview), `send` submits a prompt without the composer and `until` waits on Ultimate's state, never a guessed time: 'idle' (that conversation's turn is done), 'quiet' (nothing is busy, branches and subagents included), {entry: kind} or {event: name, where}; until defaults to 5 min (timeoutMs) and on timeout says what was still busy. Click and fill only to test the interaction itself. Scope selectors to one card or panel ('[data-entry-id=\"42\"] button:has-text(\"Retry\")', not 'button:has-text(\"Retry\")', which hits the first match on the page).",
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
              obj({ wait: union([num({ minimum: 0 }), str()]) }),
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
              obj({
                until: union([
                  lit('idle'),
                  lit('quiet'),
                  obj({ entry: str() }),
                  obj({
                    event: str(),
                    where: opt(map(unknown())),
                  }),
                ]),
                conversation: opt(int({ minimum: 1 })),
                timeoutMs: opt(int({ minimum: 1 })),
              }),
            ]),
          ),
          screenshot: opt(bool()),
        }),
        async execute(args, api, context) {
          const waits = args.steps.reduce(
            (sum, step) =>
              sum +
              ('wait' in step && typeof step.wait === 'number'
                ? step.wait
                : 'until' in step
                  ? (step.timeoutMs ?? untilTimeoutMs)
                  : 0),
            0,
          )
          return run(args, waits, api, context, async (page, outcomes, png, guard) => {
            for (const [index, step] of args.steps.entries()) {
              context.abortSignal?.throwIfAborted()
              api.output(`Step ${index + 1}: ${JSON.stringify(step)}\n`)
              try {
                let value: unknown
                if ('click' in step) await guard(page.locator(step.click).click())
                else if ('fill' in step) await guard(page.locator(step.fill[0]).fill(step.fill[1]))
                else if ('press' in step) await guard(page.keyboard.press(step.press))
                else if ('wait' in step) {
                  if (typeof step.wait === 'number')
                    await guard(page.waitForTimeout(step.wait), step.wait)
                  else await guard(page.locator(step.wait).waitFor())
                } else if ('send' in step || 'until' in step) {
                  // `window.ultimate` (web/src/sdk/test-hook.ts) appears once the page's SDK has loaded.
                  const hook = () =>
                    guard(
                      page
                        .waitForFunction(() => 'ultimate' in window)
                        .catch(() => {
                          throw new Error(
                            'This page has no window.ultimate: not an Ultimate UI, or one older than send/until steps',
                          )
                        }),
                    )
                  await hook()
                  if ('send' in step)
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
                    // The hook times out first and says what was still busy; the guard only backs it up.
                    const wait = () =>
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
                    let outcome: Awaited<ReturnType<typeof wait>>
                    for (;;) {
                      try {
                        outcome = await wait()
                        break
                      } catch (error) {
                        // A reload (hot reload, server swap) destroys the wait, not the sent turn: the page keeps its
                        // sent records in sessionStorage, so waiting again in the new page is a retry, never a resend.
                        if (!String(error).includes('Execution context was destroyed')) throw error
                        context.abortSignal?.throwIfAborted()
                        api.output('The page reloaded; waiting again\n')
                        await hook()
                      }
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
            return args.screenshot === false ? undefined : guard(capture(page, png))
          })
        },
      }),
    ].map((tool) => ({ ...tool, outputSchema: { type: 'object' } })),
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
    const stepMs = args.timeoutMs ?? stepTimeoutMs
    const totalMs = 4 * stepMs + waits
    const deadline = Date.now() + totalMs
    /** `work` within one step's limit (plus a wait it asks for) and what is left of the call's. */
    const guard = <T>(work: Promise<T>, extraMs = 0) => {
      const left = deadline - Date.now()
      return left < stepMs + extraMs
        ? within(left, work, timeout(totalMs))
        : within(stepMs + extraMs, work)
    }
    const abort = () => void close(isolated)
    try {
      const png = screenshotFile(host.home, api.env?.cwd ?? host.projectRoot, args.path)
      context.abortSignal?.throwIfAborted()
      if (!state.launched) {
        const launched: Promise<Browser> = browserBinary()
          .then(async (executablePath) => {
            const browser = await chromium.launch({
              executablePath,
              headless: true,
              // Chromium's singleton socket needs a short system temp path. Playwright still puts the profile in our TMPDIR.
              env: { ...process.env, TMPDIR: undefined },
            })
            if (state.launched === launched) state.browser = browser
            browser.once('disconnected', () => {
              if (state.launched === launched) state.launched = undefined
            })
            return browser
          })
          .catch((error) => {
            if (state.launched === launched) state.launched = undefined
            throw error
          })
        state.launched = launched
      }
      const browser = await guard(state.launched)
      context.abortSignal?.throwIfAborted()
      isolated = await guard(
        browser.newContext({
          viewport: { width: args.width ?? 1440, height: args.height ?? 900 },
          colorScheme: args.theme,
        }),
      )
      context.abortSignal?.addEventListener('abort', abort, { once: true })
      const page = await guard(isolated.newPage())
      page.setDefaultTimeout(stepMs)
      page.setDefaultNavigationTimeout(stepMs)
      context.abortSignal?.throwIfAborted()
      page.on('console', (message) => {
        if (message.type() === 'error') outcomes.push(`Console error: ${message.text()}`)
      })
      page.on('pageerror', (error) => outcomes.push(`Page error: ${error.message}`))
      const url = new URL(args.url ?? '', host.system().process.url).href
      // Any Ultimate page, this UI or a preview, gets `window.ultimate` for send/until steps.
      await guard(page.addInitScript(() => sessionStorage.setItem('ultimate.driven', '1')))
      if (new URL(url).origin === new URL(host.system().process.url).origin) {
        // Own UI: this page is detached from the shared UI state (web/src/sdk/client.ts), so its `?conversation=`
        // and clicks never move the user's tabs; the theme is this browser's preference.
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
      const title = await guard(page.title())
      context.abortSignal?.throwIfAborted()
      return {
        structuredContent: {
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
      return {
        isError: true,
        output: [{ type: 'text' as const, text: [...outcomes, String(error)].join('\n') }],
      }
    } finally {
      context.abortSignal?.removeEventListener('abort', abort)
      await close(isolated)
    }
  }

  /** Closes a call's context within a bounded time; a context that won't close takes the shared browser with it, so the next call launches a fresh one. */
  async function close(isolated: BrowserContext | undefined) {
    if (!isolated) return
    try {
      await within(closeTimeoutMs, isolated.close())
    } catch (error) {
      host.notice(`Closing a browser context failed (${String(error)}); relaunching the browser.`)
      const browser = isolated.browser()
      if (!browser) return
      if (state.browser === browser) {
        state.launched = undefined
        state.browser = undefined
      }
      // Closing kills the process too; a browser that won't even do that is left to the host's shutdown.
      await within(closeTimeoutMs, browser.close()).catch((reason: unknown) =>
        host.notice(`Closing the wedged browser failed: ${String(reason)}`),
      )
    }
  }
}
