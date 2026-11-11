// An Android WebView (react-native-webview 13.16.1, 2026-11-11) has service workers but no Notifications or Push API.
// There every page showed "extension push failed · e.getNotifications is not a function" once a question to the user
// had been answered: closing its notification called a method the registration lacks. This page deletes those APIs
// before its scripts run, as that WebView lacks them, and must show no error.
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../../browser/server.ts'
import { Started } from '../../../messages/addresses.ts'
import { Messages } from '../../../messages/api.ts'
import { context } from '../../../../server/harness.ts'
import { fauxServer, post, removeTemp, temp, until } from '../../../../test/helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('runs through an answered question without an error where the Notifications and Push APIs are missing', async () => {
  const home = await temp('ultimate-push-webview-')
  cleanup.push(() => removeTemp(home))
  await mkdir(join(home, '.ultimate'), { recursive: true })
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['push'] } }),
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  server.host.faux!.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall('message', {
          to: 'user',
          text: 'One decision.',
          questions: [{ text: 'Go?', kind: 'confirm', ref: '1' }],
        }),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Waiting on you.'),
  ])
  const created = async () => (await post(server, '/api/conversations', {})).data.id as number
  const [branch, other] = [await created(), await created()]
  // Started by another conversation, the branch may ask the user.
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Started, branch as ConversationId)).by = other
  }, context)
  await (
    await (await server.harness.conversation(branch as ConversationId, context))!.submit(
      { type: 'input', content: 'ask' },
      context,
    )
  ).wait(context)
  const log = await server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context)
  const asked = log!.messages.find((message) => message.to === 'user')!
  await post(server, '/api/extensions/questions/actions/answer', {
    args: { messageId: asked.id, text: 'yes' },
  })

  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    // Keep the profile in the test's TMPDIR, but let Chromium put its singleton socket in the short system temp path.
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage()
  await page.addInitScript(() => {
    const scope = window as unknown as Record<string, unknown>
    delete scope.Notification
    delete scope.PushManager
    const registration = ServiceWorkerRegistration.prototype as unknown as Record<string, unknown>
    delete registration.getNotifications
    delete registration.pushManager
  })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(server.url)
  // The service worker's registration is what the closing step waits for.
  await until(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())))
  await page.locator('button[aria-label="Notifications"]').waitFor()
  expect(await page.getByText('extension push failed').count()).toBe(0)
  expect(errors).toEqual([])
})
