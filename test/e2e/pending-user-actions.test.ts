/** Extension approval cards show as native pending user actions (`5022b2a3`): a real model turn seeds two durable
 * proposals through a temp project tool, the standing agent's row, the @ultimate count and To-dos agree until each
 * resolves or the deadline clears them, and clicking a waiting row reveals the existing card. Navigation asserts the
 * card is visible and its controls reachable, not exact anchoring: the shared reveal's position is the transcript's. */
import type { ConversationId } from '@earendil-works/pi-durable'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { Messages } from '../../extensions/messages/api.ts'
import { context } from '../../server/harness.ts'
import { fauxServer, post, removeTemp, sourceCopy, temp, until } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

/** The conversation's box: what the tool seeds and resolves, and its document kind as the web provider reads it. */
const refs = `
import { actionRef, docRef } from '../../../shared/extension-api.ts'

export type Proposal = { id: number; label: string; entry?: number; expiresAt?: number }
export type BoxData = { next: number; items: Proposal[]; resolved: number[] }
export const BoxDoc = docRef<BoxData>('waitbox.box')
export const ResolveAction = actionRef<{ conversation: number; id: number }, { remaining: number }>(
  'waitbox',
  'resolve',
)`

/** A real tool behind the cards: two durable proposals per call, seeded through the actual model's tool call. */
const serverSource = `
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { int, obj, opt } from '@earendil-works/pi-schema'
import { defineDoc, defineExtension, defineTool } from '@earendil-works/pi-durable'
import { implementAction } from '../../../lib/actions.ts'
import { BoxDoc, ResolveAction } from './refs.ts'
import type { BoxData } from './refs.ts'

export const Box = defineDoc<BoxData>({
  kind: BoxDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ next: 1, items: [], resolved: [] }),
})
export const docs = [Box]

export const approvalTool = defineTool({
  name: 'approval_fixture',
  description: 'Put two durable approvals on the user. For the pending-user-actions regression only.',
  parameters: obj({ expiresInMs: opt(int()) }),
  replay: 'safe',
  async execute(input, api, ctx) {
    const expiresAt =
      typeof input.expiresInMs === 'number' ? api.now() + input.expiresInMs : undefined
    const seeded = await api.commit(async (tx) => {
      const box = await tx.doc(Box, api.conversationId)
      // Strict JSON only: a proposal without a deadline carries no expiresAt field at all.
      const items = ['Ship the release', 'Rotate the signing key'].map((label) => ({
        id: box.next++,
        label,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      }))
      // The entry is the transcript card; the box keeps its id, so a pending action can open it.
      const card = await tx.appendEntry(api.conversationId, {
        kind: 'waitbox.approval',
        data: { items },
      })
      for (const item of items) box.items.push({ ...item, entry: card.id })
      return items
    }, ctx)
    return {
      output: [
        { type: 'text', text: 'Two approvals wait on you: ' + seeded.map((item) => item.label).join('; ') + '.' },
      ],
    }
  },
})

export const actions = {
  resolve: implementAction(ResolveAction, async (args, { host }) => {
    const data = (args ?? {}) as { conversation?: number; id?: number }
    if (!Number.isSafeInteger(data.conversation) || (data.conversation ?? 0) < 1)
      throw new Error('conversation must be a conversation id')
    if (!Number.isSafeInteger(data.id)) throw new Error('id must be a proposal id')
    return host.harness().commit(
      async (tx) => {
        const box = await tx.doc(Box, data.conversation as number)
        const id = data.id as number
        if (!box.items.some((item) => item.id === id)) throw new Error('Unknown proposal')
        if (!box.resolved.includes(id)) box.resolved.push(id)
        return { remaining: box.items.filter((item) => !box.resolved.includes(item.id)).length }
      },
      BACKGROUND_CONTEXT,
    )
  }),
}

export default function waitboxExtension() {
  return defineExtension({ name: 'waitbox', tools: [approvalTool] })
}`

/** The card and the point provider: the live box as `PendingUserActions`, resolved proposals included on the card. */
const webSource = `
import type { EntryRecord } from '@earendil-works/pi-durable'
import { api, defineWebExtension, provide, useConversation, useDocOf } from '@/sdk'
import { PendingUserActions } from '../../../extensions/messages/ui.tsx'
import type { PendingUserAction } from '../../../extensions/messages/ui.tsx'
import { BoxDoc, ResolveAction } from './refs.ts'
import type { BoxData, Proposal } from './refs.ts'

function usePendingUserActions(id: number): readonly PendingUserAction[] {
  const box = useDocOf(id, BoxDoc) as Readonly<BoxData> | null | undefined
  if (!box) return []
  return box.items
    .filter((item) => !box.resolved.includes(item.id))
    .map((item) => ({
      id: 'waitbox:' + item.id,
      label: item.label,
      entry: item.entry,
      expiresAt: item.expiresAt,
    }))
}

function ApprovalCard({ entry }: { entry: EntryRecord }) {
  const conversation = useConversation((state) => state.id)
  const box = useDocOf(conversation, BoxDoc) as Readonly<BoxData> | null | undefined
  const items = ((entry.data ?? {}) as { items?: Proposal[] }).items ?? []
  return (
    <div
      data-waitbox-card={entry.id}
      className="my-1 w-fit rounded-md border border-border bg-card px-3 py-2 text-sm"
    >
      <p className="mb-1 font-medium">Waiting on you</p>
      {items.map((item) => {
        if (box?.resolved.includes(item.id))
          return (
            <p key={item.id} data-waitbox-resolved={item.id} className="text-muted-foreground">
              {item.label} · resolved
            </p>
          )
        return (
          <p key={item.id} className="flex items-center gap-2">
            <span>{item.label}</span>
            <button
              type="button"
              data-waitbox-resolve={item.id}
              className="cursor-pointer rounded-sm border border-border px-2 py-0.5 hover:bg-muted"
              onClick={() => void api.action(ResolveAction, { conversation: conversation ?? 0, id: item.id })}
            >
              Resolve
            </button>
          </p>
        )
      })}
    </div>
  )
}

export default defineWebExtension({
  provides: [provide(PendingUserActions, usePendingUserActions)],
  entries: { 'waitbox.approval': ApprovalCard },
})`

/** A resident standing agent whose only tool is the approval seeding, so its turn waits on you and stops. */
const agentDefinition = `---
name: fixture
description: The regression's standing agent; it puts two approvals on the user and answers in one line
resident: true
tools: [approval_fixture]
---
Record what approval_fixture reports and answer in one line. Never approve anything yourself.`

/** A fixture with a waitbox project extension, its resident @fixture, a browser, and the first seeded turn. */
async function setup() {
  const home = await temp('ultimate-pending-user-actions-')
  cleanup.push(() => removeTemp(home))
  const root = await sourceCopy(home)
  // The source copy has no .git; clone-update checks are unrelated to approval status.
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['update'] } }),
  )
  const extension = join(root, '.ultimate/extensions/waitbox')
  await mkdir(extension, { recursive: true })
  await mkdir(join(root, '.ultimate/agents'), { recursive: true })
  await writeFile(join(extension, 'refs.ts'), refs)
  await writeFile(join(extension, 'server.ts'), serverSource)
  await writeFile(join(extension, 'web.tsx'), webSource)
  await writeFile(join(root, '.ultimate/agents/fixture.md'), agentDefinition)
  const server = await fauxServer({
    ultimateRoot: root,
    projectRoot: root,
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  const created = async () =>
    (
      await post(server, '/api/extensions/subagents/actions/standing', {
        args: { name: 'fixture' },
      })
    ).data.result as number
  const fixture = await created()
  // Seeding goes through the model: the newest user input newer than the last approval tool result gets a tool
  // call; the result's next turn answers plain. Prompt sections may follow the input as system messages, so the
  // route never reads `at(-1)`, and each seed names its own tool-call id, so no generation dedupes another's.
  let seed = 0
  const route: FauxResponseFactory = (transcript) => {
    server.host.faux!.appendResponses([route])
    const messages = transcript.messages
    let userAt = -1
    let toolAt = -1
    for (const [index, message] of messages.entries()) {
      if (message.role === 'user') userAt = index
      if (
        message.role === 'toolResult' &&
        (message as { toolName?: string }).toolName === 'approval_fixture'
      )
        toolAt = index
    }
    const input = userAt > toolAt ? messages[userAt] : undefined
    const content = typeof input?.content === 'string' ? input.content : undefined
    if (content?.startsWith('approve'))
      return fauxAssistantMessage(
        [
          fauxText('Both go on your desk.'),
          fauxToolCall('approval_fixture', {}, { id: 'tool:waitbox-' + ++seed }),
        ],
        { stopReason: 'toolUse' },
      )
    if (content?.startsWith('also seed with a deadline'))
      return fauxAssistantMessage(
        [
          fauxText('On your desk, with a deadline.'),
          fauxToolCall('approval_fixture', { expiresInMs: 6000 }, { id: 'tool:waitbox-' + ++seed }),
        ],
        { stopReason: 'toolUse' },
      )
    return fauxAssistantMessage('Waiting on you.')
  }
  server.host.faux!.setResponses([route])
  const run = async (content: string) => {
    const conversation = (await server.harness.conversation(fixture as ConversationId, context))!
    return (await conversation.submit({ type: 'input', content }, context)).wait(context)
  }
  expect((await run('approve the release')).status).toBe('done')
  const latestEntry = (conversation: number) =>
    server.harness.commit((tx) => tx.latestEntryId(conversation as ConversationId), context)

  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    // Keep the profile in the test's TMPDIR, but let Chromium put its singleton socket in the short system temp path.
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  return { server, fixture, run, latestEntry, browser }
}

it('shows a standing agent waiting after the turn seeds approvals, and clears them as they resolve or expire', async () => {
  const { server, fixture, run, latestEntry, browser } = await setup()
  await post(server, '/api/ui', { set: { 'shell.panel': 'todos', 'shell.panelOpen': true } })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(server.url)

  const row = (name: string) => page.locator(`[data-standing="${name}"]`)
  const word = async (name: string) => (await row(name).textContent()) ?? ''
  const says = (name: string, text: string) => word(name).then((shown) => shown.includes(text))
  /** The @ultimate slot renders a placeholder row until its summary exists, so read both transiently. */
  const ultimateSays = async (text: string, every = false) => {
    const rows = row('ultimate')
    const count = await rows.count()
    if (count === 0) return false
    const found = await Promise.all(
      Array.from({ length: count }, (_, index) => rows.nth(index).textContent()),
    )
    const names = found.map((entry) => entry ?? '')
    return every
      ? names.every((entry) => entry.includes(text))
      : names.some((entry) => entry.includes(text))
  }
  // The turn ended idle, but the seeded approvals keep the native row, @ultimate's count and To-dos agreeing.
  await until(() => says('fixture', '2 waiting on you'), 10_000)
  await until(() => ultimateSays('2 waiting on you'), 10_000)
  const todos = page.locator('[data-todos]')
  await until(async () => (await todos.locator('[data-todo-action]').count()) === 2, 10_000)
  const panel = ((await todos.textContent()) ?? '').replace(/\s+/g, ' ')
  expect(panel).toContain('2 actions')
  expect(panel).toContain('Ship the release')
  expect(panel).toContain('Rotate the signing key')
  // Nothing asked a question: no question records exist and no message to the user is open or stored.
  expect(await todos.locator('[data-todo-question]').count()).toBe(0)
  const log = (await server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!
  expect(log.messages.filter((message) => message.to === 'user')).toHaveLength(0)

  // Adding a conversation must not remount the panel (with or without providers): a collector above the view
  // would drop the unfinished draft, so the observers stay siblings of it while a new conversation arrives.
  const draft = todos.locator('input[aria-label="New to-do"]')
  await draft.fill('Check the deploy window')
  const added = Number((await post(server, '/api/conversations', {})).data.id)
  // The hook state carries the new conversation: the collapsed Earlier section counts it, and opening it mounts
  // its row. The draft survives the list change (a collector above the view would have dropped it on the remount).
  const earlier = page.getByRole('button', { name: 'Earlier · 1' })
  await until(() => earlier.isVisible(), 10_000)
  await earlier.click()
  await until(
    async () => (await page.locator(`[data-conversation="${added}"]`).count()) === 1,
    10_000,
  )
  const value = 'Check the deploy window'
  await until(async () => (await draft.inputValue()) === value, 10_000)
  expect(await draft.inputValue()).toBe(value)
  await until(async () => (await todos.locator('[data-todo-action]').count()) === 2, 10_000)

  // A reload re-reads the durable doc: the row and To-dos keep waiting. The reload paints the previous view as a
  // resume cover until the app beneath settles, so wait it out before reading or clicking anything.
  await page.reload()
  await until(
    async () => (await page.evaluate(() => document.getElementById('resume'))) === null,
    10_000,
  )
  await until(() => says('fixture', '2 waiting on you'), 10_000)
  await until(async () => (await todos.locator('[data-todo-action]').count()) === 2, 10_000)

  // Clicking the waiting row reveals the existing card with its controls reachable: no exact gap asserted here.
  await row('fixture').locator('button').first().click()
  const card = page.locator('[data-waitbox-card]').first()
  await until(async () => {
    const box = await card.boundingBox()
    return !!box && box.y >= 0 && box.y + box.height <= 900
  }, 10_000)
  await page.locator('[data-waitbox-resolve="1"]').click()

  // One remaining proposal keeps the row waiting; the last one leaves it idle.
  await until(() => says('fixture', '1 waiting on you'), 10_000)
  await until(() => ultimateSays('1 waiting on you'), 10_000)
  await until(async () => (await todos.locator('[data-todo-action]').count()) === 1, 10_000)
  await page.locator('[data-waitbox-resolve="2"]').click()
  await until(() => says('fixture', 'idle'), 10_000)
  await until(async () => (await todos.locator('[data-todo-action]').count()) === 0, 10_000)
  await until(() => ultimateSays('idle', true), 10_000)
  expect(((await todos.textContent()) ?? '').replace(/\s+/g, ' ')).toContain('none open')
  expect(await page.locator('[data-waitbox-resolved]').count()).toBe(2)
  expect(await page.locator('[data-waitbox-resolve]').count()).toBe(0)

  // A deadline clears on the browser clock alone: the second batch expires with no click, no new request
  // and no new entry — the run that seeded it was the conversation's last.
  expect((await run('also seed with a deadline')).status).toBe('done')
  await until(() => says('fixture', '2 waiting on you'), 10_000)
  await until(async () => (await todos.locator('[data-todo-action]').count()) === 2, 10_000)
  const quiet = await latestEntry(fixture)
  await until(() => says('fixture', 'idle'), 15_000)
  await until(async () => (await todos.locator('[data-todo-action]').count()) === 0, 15_000)
  await until(() => ultimateSays('idle', true), 15_000)
  // Nothing ran for the expiry: the conversation is idle and history gained no entry.
  await (await server.harness.conversation(fixture as ConversationId, context))!.waitForIdle(
    context,
  )
  expect(await latestEntry(fixture)).toBe(quiet)
  expect(pageErrors).toEqual([])
})
