import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import browserExtension from '../../server.ts'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { context } from '../../../../server/harness.ts'
import { EventFeed } from '../../../../server/events.ts'
import type { ExtensionHost } from '../../../../server/extensions.ts'
import { ChangedEvent } from '../../../../shared/events.ts'
import { UiState } from '../../../../shared/ui-state.ts'
import { fauxServer, removeTemp, temp } from '../../../../test/helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

const panel = `/** @jsxImportSource @solidjs/web */
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.solid.tsx'
import { Switch } from '@/components/ui/switch.solid.tsx'
import { useExtensionUiState } from '@/sdk/solid'

export function Digest() {
  const digest = useExtensionUiState('digest', false)
  return (
    <>
      <Switch aria-label="Weekly digest" bind={digest} />
      <Popover>
        <PopoverTrigger aria-label="Digest details">details</PopoverTrigger>
        <PopoverContent>Sent on Mondays</PopoverContent>
      </Popover>
    </>
  )
}
`
const web = `import { defineWebExtension, island } from '@/sdk'
import { Digest } from './digest.solid.tsx'
export default defineWebExtension({ slots: { 'statusline.left': island(Digest) } })
`

type Component = { ref: string; label?: string; component: string }

async function serve(settings?: object) {
  const home = await temp('ultimate-browser-ui-')
  cleanup.push(() => removeTemp(home))
  const folder = join(home, '.ultimate/extensions/digest')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'digest.solid.tsx'), panel)
  await writeFile(join(folder, 'web.tsx'), web)
  if (settings) await writeFile(join(home, '.ultimate/settings.json'), JSON.stringify(settings))
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())

  const host = {
    home: join(home, 'shots'),
    projectRoot: home,
    resource: <T>(_name: string, create: () => T) => create(),
    onClose: (close: () => Promise<void>) => cleanup.push(close),
    notice() {},
    system: () => ({ process: { url: 'http://127.0.0.1:1/' } }),
  } as unknown as ExtensionHost
  const browser = browserExtension(host).tools!.find((tool) => tool.name === 'browser')!
  const api = { output() {} } as unknown as ToolExecutionApi
  const drive = async (steps: object[]) => {
    const result = await browser.execute(
      { url: server.url, screenshot: false, steps: steps as never },
      api,
      context,
    )
    expect(result).not.toHaveProperty('isError', true)
    const { outcomes } = (result as unknown as { structuredContent: { outcomes: string[] } })
      .structuredContent
    return (n: number) => {
      const prefix = `Step ${n}: OK `
      const line = outcomes.find((outcome) => outcome.startsWith(prefix))
      if (!line) throw new Error(`No step ${n} in:\n${outcomes.join('\n')}`)
      return JSON.parse(line.slice(prefix.length)) as unknown
    }
  }
  const changes = async () =>
    ((await server.harness.snapshot(EventFeed, ROOT_CONVERSATION_ID, context))?.events ?? [])
      .filter((event) => ChangedEvent.is(event))
      .map((event) => event.data)
  const recorded = changes
  const uiState = async () =>
    (await server.harness.snapshot(UiState, ROOT_CONVERSATION_ID, context)) ?? {}
  return { drive, changes, recorded, uiState }
}

const digest = { component: 'switch', label: 'Weekly digest', checked: false }

it('snapshots, queries and acts on ui-sdk controls from the first step, and the server records the agent’s write once', async () => {
  const { drive, recorded, uiState } = await serve()
  const snapshot = await drive([{ ui: 'snapshot' }])
  const found = (snapshot(1) as Component[]).find((item) => item.label === 'Weekly digest')
  expect(found).toMatchObject({ ...digest, actions: ['setChecked'] })

  const value = await drive([
    { ui: 'query', text: 'digest' },
    { ui: 'act', steps: [{ ref: 'Weekly digest', action: 'setChecked', args: [true] }] },
  ])
  const queried = (value(1) as Component[]).find((item) => item.label === 'Weekly digest')
  expect(queried).toMatchObject(digest)
  expect(value(2)).toMatchObject({ ok: true, values: { [`${queried!.ref} Weekly digest`]: true } })

  expect(await uiState()).toMatchObject({ 'ext.digest.digest': true })
  expect(await recorded()).toEqual([
    {
      key: 'ext.digest.digest',
      value: true,
      source: 'agent',
      device: expect.any(String),
    },
  ])
})

it('sends a final keypress’s UI-state write, with its event, before it closes the page, without pagehide', async () => {
  const { drive, recorded, uiState } = await serve()
  const value = await drive([
    { ui: 'snapshot' },
    {
      eval: "addEventListener('pagehide', (event) => event.stopImmediatePropagation(), { capture: true })",
    },
    { eval: 'document.querySelector(\'[aria-label="Weekly digest"]\').focus()' },
    { press: ' ' },
    {
      eval: "document.querySelector('[aria-label=\"Weekly digest\"]').getAttribute('aria-checked')",
    },
  ])
  expect(value(5)).toBe('true')
  expect(await uiState()).toMatchObject({ 'ext.digest.digest': true })
  expect(await recorded()).toEqual([
    expect.objectContaining({
      key: 'ext.digest.digest',
      value: true,
      source: 'agent',
    }),
  ])
})

it('sends a final keypress’s UI-state write on pagehide in one keepalive request, before the page goes', async () => {
  const { drive } = await serve()
  const value = await drive([
    { ui: 'snapshot' },
    {
      eval: "(() => { const sent = []; const send = window.fetch; const held = new Promise((release) => { window.releaseFlush = release }); window.fetch = (url, init) => { if (!String(url).endsWith('/api/ui')) return send(url, init); sent.push({ keepalive: init?.keepalive === true, body: JSON.parse(init.body) }); return init?.keepalive ? send(url, init) : held.then(() => send(url, init)) }; window.exitSent = sent; return true })()",
    },
    { eval: 'document.querySelector(\'[aria-label="Weekly digest"]\').focus()' },
    { press: ' ' },
    { wait: '[aria-label="Weekly digest"][aria-checked="true"]' },
    {
      eval: "(() => { window.exitSent.length = 0; dispatchEvent(new PageTransitionEvent('pagehide')); return window.exitSent })()",
    },
    { eval: 'window.releaseFlush()' },
  ])
  expect(value(6)).toEqual([
    {
      keepalive: true,
      body: expect.objectContaining({
        ops: expect.arrayContaining([
          { key: 'ext.digest.digest', value: true, who: 'agent', seq: expect.any(Number) },
        ]),
      }),
    },
  ])
})

it('records nothing from the agent when it opens and closes a popover', async () => {
  const { drive, changes } = await serve()
  const value = await drive([
    { ui: 'act', steps: [{ ref: 'Digest details', action: 'setOpen', args: [true] }] },
    { ui: 'act', steps: [{ ref: 'Digest details', action: 'setOpen', args: [false] }] },
  ])
  expect(value(1)).toMatchObject({ ok: true })
  expect(value(2)).toMatchObject({ ok: true })
  expect(await changes()).toEqual([])
})
