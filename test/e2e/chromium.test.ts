import { existsSync } from 'node:fs'
import { chromium, type BrowserServer } from 'playwright-core'
import { expect, it, vi } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { launchChromium } from '../chromium.ts'

it('kills and reaps its browser and removes its profile when graceful shutdown stalls', async () => {
  let server: BrowserServer | undefined
  const gracefulClose = vi.fn<BrowserServer['close']>(() => new Promise<void>(() => {}))
  const browser = await launchChromium(
    {
      executablePath: await browserBinary(),
      headless: true,
      env: { ...process.env, TMPDIR: undefined },
    },
    async (options) => {
      server = await chromium.launchServer(options)
      vi.spyOn(server, 'close').mockImplementation(gracefulClose)
      return server
    },
  )
  const owned = server!
  const child = owned.process()
  const profile = child.spawnargs.find((arg) => arg.startsWith('--user-data-dir='))?.split('=')[1]
  try {
    expect(profile).toBeTruthy()
    expect(existsSync(profile!)).toBe(true)
    const context = await browser.newContext()
    await context.newPage()
    const closed = vi.fn<() => void>()
    context.on('close', closed)
    const started = performance.now()
    await browser.close()
    expect(performance.now() - started).toBeLessThan(4500)
    expect(closed).toHaveBeenCalledOnce()
    expect(gracefulClose).toHaveBeenCalledOnce()
    expect(child.signalCode).toBe('SIGKILL')
    expect(() => process.kill(child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    expect(existsSync(profile!)).toBe(false)
    await browser.close()
    expect(gracefulClose).toHaveBeenCalledOnce()
  } finally {
    await owned.kill()
  }
})
