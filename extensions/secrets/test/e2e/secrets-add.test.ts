// The panel listed only declared and stored names, so a user could not store a secret of their own.
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../../browser/server.ts'
import { readSecret } from '../../../../lib/secrets.ts'
import { fauxServer, removeTemp, temp } from '../../../../test/helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('adds a secret under a name the user types, refusing an invalid one inline', async () => {
  const home = await temp('ultimate-secrets-add-')
  cleanup.push(() => removeTemp(home))
  await mkdir(join(home, '.ultimate'), { recursive: true })
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(server.url)
  await page.locator('#app [data-ui="composer"] textarea').waitFor()
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByPlaceholder('Run a command…').fill('Secrets')
  await page.locator('[data-slot="command-item"]', { hasText: 'Secrets…' }).click()
  await page.getByRole('button', { name: 'Add a secret' }).click()

  const name = page.getByLabel('Name of the new secret')
  await name.fill('1_KEY')
  await expect.poll(() => name.getAttribute('aria-invalid')).toBe('true')
  await page.getByText('Start with a letter').waitFor()
  await name.fill('my_key')
  await expect.poll(() => name.inputValue()).toBe('MY_KEY')
  await expect.poll(() => name.getAttribute('aria-invalid')).toBe('false')
  const value = ['test', 'value'].join('-')
  await page.getByLabel('Value', { exact: true }).fill(value)
  await page.keyboard.press('Enter')

  await page.locator('li[aria-label="MY_KEY"]').getByText('no enabled extension needs it').waitFor()
  expect(await readSecret(home, 'MY_KEY')).toBe(value)
})
