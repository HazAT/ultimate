import { resolve } from 'node:path'
import { chromium } from 'playwright-core'
import type { Page } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../../browser/server.ts'
import { fauxServer, removeTemp, temp, until } from '../../../../test/helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

async function runASkillFromThePalette(page: Page) {
  await page.keyboard.press('Control+k')
  await page.keyboard.type('Run a skill')
  await page.keyboard.press('Enter')
  await page.getByRole('combobox', { name: 'Find a skill' }).waitFor()
}

const focusedId = (page: Page) => page.evaluate(() => document.activeElement?.id)

it('fills and focuses the composer the open modal made inert, and returns focus to the opener when dismissed while opening', async () => {
  const home = await temp('ultimate-skill-picker-')
  cleanup.push(() => removeTemp(home))
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: `${home}/state`,
    port: 0,
  })
  cleanup.push(() => server.close())
  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ reducedMotion: 'reduce' })
  await page.goto(server.url)
  const composer = page.locator('#composer-input[data-conversation]')
  await composer.waitFor()

  await runASkillFromThePalette(page)
  await page.keyboard.type('verify-ui')
  await page.keyboard.press('Enter')
  await until(async () => (await focusedId(page)) === 'composer-input')
  await page.keyboard.type('x')
  await until(async () => (await composer.inputValue()) === '/skill:verify-ui x')

  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await composer.fill('')
  await page.evaluate(() => {
    const opener = document.createElement('button')
    opener.id = 'opener'
    opener.textContent = 'Opener'
    document.body.append(opener)
    opener.focus()
  })
  await page.evaluate(() =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }),
    ),
  )
  await page.keyboard.type('Run a skill')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await page.getByRole('dialog', { name: 'Run a skill' }).waitFor({ state: 'detached' })
  expect(await focusedId(page)).not.toBe('composer-input')
})
