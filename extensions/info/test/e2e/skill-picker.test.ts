import { chromium } from 'playwright-core'
import type { Page } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../../browser/server.ts'
import { prebuiltServer, removeTemp, temp, until } from '../../../../test/helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

async function openSkillPicker(page: Page) {
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('Run a skill')
  await page.keyboard.press('Enter')
}

const picker = (page: Page) => page.getByRole('combobox', { name: 'Find a skill' })
const focusedId = (page: Page) => page.evaluate(() => document.activeElement?.id)

it('fills and focuses the composer in front, whose page the open modal made inert, and leaves it alone when a reopened picker is dismissed', async () => {
  const home = await temp('ultimate-skill-picker-')
  cleanup.push(() => removeTemp(home))
  const server = await prebuiltServer({
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
  const main = page.locator('#composer-input[data-conversation]')
  await main.waitFor()
  await until(() =>
    page.evaluate(() => !!document.getElementById('composer-input')?.closest('main')),
  )
  await page.evaluate(() => {
    const host = document.createElement('div')
    host.dataset.composerTarget = 'scope'
    const side = document.createElement('textarea')
    side.id = 'side-composer'
    side.dataset.conversation = '424242'
    host.append(side)
    document.body.append(host)
    document.getElementById('composer-input')!.closest('main')!.inert = true
    side.focus()
  })

  await openSkillPicker(page)
  await picker(page).waitFor()
  await page.keyboard.type('verify-ui')
  await page.keyboard.press('Enter')
  await until(async () => (await focusedId(page)) === 'side-composer')
  expect(await main.inputValue()).toBe('')
  expect(await page.evaluate(() => localStorage.getItem('ultimate.draft.424242'))).toBe(
    '/skill:verify-ui ',
  )

  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.evaluate(() => {
    const opener = document.createElement('button')
    opener.id = 'opener'
    opener.textContent = 'Opener'
    document.body.append(opener)
    opener.focus()
  })
  await openSkillPicker(page)
  await picker(page).waitFor()
  await page.keyboard.press('Escape')
  await picker(page).waitFor({ state: 'detached' })
  expect(await focusedId(page)).not.toBe('side-composer')
  expect(await page.evaluate(() => localStorage.getItem('ultimate.draft.424242'))).toBe(
    '/skill:verify-ui ',
  )
})
