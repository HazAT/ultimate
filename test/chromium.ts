import { chromium, type Browser } from 'playwright-core'
import { deadline } from '../lib/timers.ts'

export async function launchChromium(
  options: Parameters<typeof chromium.launchServer>[0],
  launchServer = chromium.launchServer.bind(chromium),
): Promise<Browser> {
  const server = await launchServer(options)
  try {
    const browser = await chromium.connect(server.wsEndpoint())
    let closing: Promise<void> | undefined
    browser.close = (closeOptions) => {
      closing ??= (async () => {
        let cancel: (() => void) | undefined
        try {
          await Promise.race([
            (async () => {
              await Promise.all(browser.contexts().map((context) => context.close(closeOptions)))
              await server.close()
            })(),
            new Promise<void>((resolve) => {
              cancel = deadline(2500, resolve)
            }),
          ])
        } finally {
          cancel?.()
          await server.kill()
        }
      })()
      return closing
    }
    return browser
  } catch (error) {
    await server.kill()
    throw error
  }
}
