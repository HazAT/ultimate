import { join, resolve } from 'node:path'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../../browser/server.ts'
import type { ModelsResponse } from '../../../../shared/protocol.ts'
import { fauxServer, post, removeTemp, temp } from '../../../../test/helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('lets Get ready hand focus and pointer input to login and the model picker and get focus back', async () => {
  const home = await temp('ultimate-get-ready-dialogs-')
  cleanup.push(() => removeTemp(home))
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: join(home, 'state'),
    port: 0,
    faux: fauxProvider({ models: [{ id: 'faux-1' }, { id: 'faux-2' }] }),
  })
  cleanup.push(() => server.close())
  const id = (await post(server, '/api/conversations', {})).data.id as number
  await post(server, `/api/conversations/${id}/configure`, {
    model: { provider: 'faux', modelId: 'faux-1' },
  })
  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ reducedMotion: 'reduce' })
  await page.route('**/api/models', async (route) => {
    const response = await route.fetch()
    const catalog = (await response.json()) as ModelsResponse
    const json: ModelsResponse = {
      providers: catalog.providers.map((provider) => ({
        ...provider,
        status: { configured: false },
      })),
      models: catalog.models.map((model) =>
        model.provider === 'faux' && model.id === 'faux-1' ? { ...model, available: false } : model,
      ),
    }
    await route.fulfill({ response, json })
  })
  await page.goto(`${server.url}/?conversation=${id}`)
  await page.locator('#composer-input').waitFor()
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByPlaceholder('Run a command…').fill('Set the thinking level')
  await page.keyboard.press('Enter')
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByPlaceholder('Run a command…').fill('Get ready')
  await page.keyboard.press('Enter')

  const ready = page.getByRole('dialog', { name: 'Get ready' })
  const focused = page.locator(':focus')
  const connect = ready.getByRole('button', { name: 'Connect', exact: true })
  const choose = ready.getByRole('button', { name: /^(Choose|Change)$/ })
  await connect.click()
  const providers = page.getByRole('textbox', { name: 'Search login providers' })
  await providers.and(focused).waitFor({ timeout: 5_000 })
  await providers.pressSequentially('deepseek')
  await page
    .getByRole('button', { name: 'DeepSeek API key (API key, deepseek)', exact: true })
    .click()
  await page.locator('[data-agent-secret] input').and(focused).waitFor({ timeout: 5_000 })
  await page.keyboard.press('Escape')
  await connect.and(focused).waitFor({ timeout: 5_000 })

  await choose.click()
  const models = page.getByRole('combobox', { name: 'Search model catalog' })
  await models.and(focused).waitFor({ timeout: 5_000 })
  await page.keyboard.press('Escape')
  await choose.and(focused).waitFor({ timeout: 5_000 })
  await choose.click()
  await models.and(focused).waitFor({ timeout: 5_000 })
  await models.pressSequentially('faux-2')
  const row = page.getByRole('option').filter({ hasText: 'faux-2' })
  await row.waitFor({ timeout: 5_000 })
  const [configured] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith(`/conversations/${id}/configure`)),
    row.click(),
  ])
  expect(configured.ok()).toBe(true)
  expect(configured.request().postDataJSON()).toEqual({
    model: { provider: 'faux', modelId: 'faux-2' },
  })
  await ready
    .getByRole('button', { name: 'Change', exact: true })
    .and(focused)
    .waitFor({ timeout: 5_000 })
})
