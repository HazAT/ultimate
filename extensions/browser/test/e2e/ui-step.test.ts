import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { afterAll, beforeAll, expect, it } from 'vitest'
import browserExtension from '../../server.ts'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { context } from '../../../../server/harness.ts'
import { EventFeed } from '../../../../server/events.ts'
import type { ExtensionHost } from '../../../../server/extensions.ts'
import { ChangedEvent } from '../../../../shared/events.ts'
import { UiState } from '../../../../shared/ui-state.ts'
import { fauxServer, removeTemp, temp } from '../../../../test/helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterAll(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

const panel = `/** @jsxImportSource @solidjs/web */
import { createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.solid.tsx'
import { Switch } from '@/components/ui/switch.solid.tsx'
import { useExtensionUiState } from '@/sdk/solid'

export function Digest() {
  const digest = useExtensionUiState('digest', false)
  const [pressed, setPressed] = createSignal('none')
  const [many, setMany] = createSignal(false)
  const [hidden, setHidden] = createSignal(false)
  return (
    <>
      <Switch aria-label="Weekly digest" bind={digest} />
      <Switch aria-label="Many fields" checked={many()} onCheckedChange={setMany} />
      <Switch aria-label="Hide the last filler" checked={hidden()} onCheckedChange={setHidden} />
      {many() && Array.from({ length: 120 }, (_, index) => (
        <span aria-hidden={hidden() && index === 119 ? 'true' : undefined}>
          <Switch aria-label={'Filler ' + index} />
        </span>
      ))}
      <Button aria-label="Read digest-archive.png" data-pressed={pressed()} onClick={() => setPressed('read')}>read</Button>
      <Button aria-label="Digest archive" onClick={() => setPressed('archive')}>Archive</Button>
      <Button aria-label="Archive c9999" onClick={() => setPressed('c9999')}>c9999</Button>
      <Popover>
        <PopoverTrigger aria-label="Digest details">details</PopoverTrigger>
        <PopoverContent>
          Sent on Mondays
          <Button aria-label="Archive" onClick={() => setPressed('popover archive')}>Archive</Button>
          <Switch aria-label="Monday only" />
        </PopoverContent>
      </Popover>
    </>
  )
}
`
const web = `import { defineWebExtension } from '@/sdk/solid'
import { Digest } from './digest.solid.tsx'
export default defineWebExtension({ slots: { 'statusline.left': Digest } })
`

type Component = { ref: string; label?: string; component: string }

async function boot() {
  const home = await temp('ultimate-browser-ui-')
  cleanup.push(() => removeTemp(home))
  const folder = join(home, '.ultimate/extensions/digest')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'digest.solid.tsx'), panel)
  await writeFile(join(folder, 'web.solid.tsx'), web)
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
  const api = { output() {}, watchDoc: async () => undefined } as unknown as ToolExecutionApi
  const drive = async (steps: object[]) => {
    const result = await browser.execute(
      { url: server.url, screenshot: false, steps: steps as never },
      api,
      context,
    )
    if (result.isError) throw new Error(JSON.stringify(result.output))
    const { outcomes } = (result as unknown as { structuredContent: { outcomes: string[] } })
      .structuredContent
    return (n: number) => {
      const prefix = `Step ${n}: OK `
      const line = outcomes.find((outcome) => outcome.startsWith(prefix))
      if (!line) throw new Error(`No step ${n} in:\n${outcomes.join('\n')}`)
      return JSON.parse(line.slice(prefix.length)) as unknown
    }
  }
  const allChanges = async () =>
    ((await server.harness.snapshot(EventFeed, ROOT_CONVERSATION_ID, context))?.events ?? [])
      .filter((event) => ChangedEvent.is(event))
      .map((event) => event.data)
  const uiState = async () =>
    (await server.harness.snapshot(UiState, ROOT_CONVERSATION_ID, context)) ?? {}
  return { drive, allChanges, uiState, server }
}

let shared: Awaited<ReturnType<typeof boot>>
beforeAll(async () => {
  shared = await boot()
}, 60_000)

/** The tests share one server and its one UI state: each starts from an unset digest and sees only its own changes. */
async function serve() {
  const { drive, allChanges, uiState, server } = shared
  await server.harness.commit(async (tx) => {
    delete (await tx.doc(UiState, ROOT_CONVERSATION_ID))['ext.digest.digest']
  }, context)
  const seen = (await allChanges()).length
  const changes = async () => (await allChanges()).slice(seen)
  return { drive, changes, recorded: changes, uiState }
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

// Pressing 'System' pressed a transcript row named "read ~/fw-verify/live-system.png" instead of the System tab:
// ui-sdk ranks a whole-word match with the exact label and then prefers the open one (#835504).
it('acts on the one control with the exact label, also one an earlier step brought onto the page', async () => {
  const { drive } = await serve()
  const value = await drive([
    { ui: 'act', steps: [{ ref: 'Digest archive', action: 'press' }] },
    { eval: "document.querySelector('[data-pressed]').dataset.pressed" },
    {
      ui: 'act',
      steps: [
        { ref: 'Digest details', action: 'setOpen', args: [true] },
        { ref: 'Archive', action: 'press' },
      ],
    },
    { eval: "document.querySelector('[data-pressed]').dataset.pressed" },
  ])
  expect(value(1)).toMatchObject({ ok: true })
  expect(value(2)).toBe('archive')
  expect(value(3)).toMatchObject({ ok: true, steps: [{ step: 0 }, { step: 1 }] })
  expect(value(4)).toBe('popover archive')
  const closed = await drive([
    {
      ui: 'act',
      steps: [
        { ref: 'Digest details', action: 'setOpen', args: [true] },
        { ref: 'Digest details', action: 'setOpen', args: [false] },
      ],
    },
  ])
  expect(closed(1)).toMatchObject({ ok: true, appeared: [] })
  expect(closed(1)).not.toHaveProperty('open')
  const later = await drive([
    {
      ui: 'act',
      steps: [
        { ref: 'Digest details', action: 'setOpen', args: [true] },
        { ref: 'Monday only', action: 'setChecked', args: [true] },
        { ref: 'Digest details', action: 'setOpen', args: [false] },
      ],
    },
  ])
  const { values } = later(1) as { values: Record<string, unknown> }
  expect(Object.entries(values).find(([key]) => key.endsWith(' Monday only'))?.[1]).toBe(true)
  expect(Object.keys(values).some((key) => key.endsWith(' Weekly digest'))).toBe(true)
})

it('keeps the fields a batch touched within the 100-field cap, with the right count, unless they left', async () => {
  const { drive } = await serve()
  const value = await drive([
    { ui: 'act', steps: [{ ref: 'Many fields', action: 'setChecked', args: [true] }] },
    {
      ui: 'act',
      steps: [
        { ref: 'Filler 119', action: 'setChecked', args: [true] },
        { ref: 'Digest details', action: 'setOpen', args: [true] },
      ],
    },
    {
      ui: 'act',
      steps: [
        { ref: 'Filler 119', action: 'setChecked', args: [false] },
        { ref: 'Hide the last filler', action: 'setChecked', args: [true] },
        { ref: 'Digest details', action: 'setOpen', args: [true] },
      ],
    },
  ])
  const kept = (value(2) as { values: Record<string, unknown> }).values
  const keys = Object.keys(kept).filter((key) => key !== 'more')
  expect(Object.entries(kept).find(([key]) => key.endsWith(' Filler 119'))?.[1]).toBe(true)
  expect(keys.length).toBe(100)
  expect(keys.length + (kept.more as number)).toBe(125)
  const hiddenLater = (value(3) as { values: Record<string, unknown> }).values
  expect(Object.keys(hiddenLater).some((key) => key.endsWith(' Filler 119'))).toBe(false)
  expect(Object.keys(hiddenLater).filter((key) => key !== 'more').length).toBe(100)
  const all = await drive([
    { ui: 'act', steps: [{ ref: 'Many fields', action: 'setChecked', args: [true] }] },
    {
      ui: 'act',
      steps: [
        ...Array.from({ length: 101 }, (_, index) => ({
          ref: `Filler ${index}`,
          action: 'setChecked',
          args: [true],
        })),
        { ref: 'Digest details', action: 'setOpen', args: [true] },
      ],
    },
  ])
  const touchedAll = (all(2) as { values: Record<string, unknown> }).values
  const listed = Object.keys(touchedAll).filter((key) => key !== 'more')
  expect(listed.length).toBe(100)
  expect(listed.length + (touchedAll.more as number)).toBe(125)
})

it('until a control’s state wakes on its change, by label or by ref, and a missing ref is never a label', async () => {
  const { drive } = await serve()
  const waitThenToggle = (target: string) =>
    `(async () => { const ui = window.ultimate.ui; const [{ ref }] = await ui.query({ text: 'Weekly digest' }); const target = ${target}; let toggled = false; let early = false; const waiting = window.ultimate.until({ ui: target, is: { checked: !document.querySelector('[aria-label="Weekly digest"]').matches('[aria-checked="true"]') } }, { timeoutMs: 5000 }).then((found) => { early = !toggled; return found }); await new Promise((later) => setTimeout(later, 300)); toggled = true; document.querySelector('[aria-label="Weekly digest"]').click(); const found = await waiting; return { early, same: found.ref === ref, checked: found.checked } })()`
  const value = await drive([
    { eval: waitThenToggle("'Weekly digest'") },
    { eval: waitThenToggle('ref') },
    { ui: 'act', steps: [{ ref: 'c9999', action: 'press' }] },
    { eval: "document.querySelector('[data-pressed]').dataset.pressed" },
  ])
  expect(value(1)).toEqual({ early: false, same: true, checked: true })
  expect(value(2)).toEqual({ early: false, same: true, checked: false })
  expect(value(3)).toMatchObject({
    ok: false,
    error: { step: 0, message: 'No component c9999 on the page.' },
  })
  expect(value(4)).toBe('none')
})

// An until on an event that never came held a browser call for 3 minutes; without timeoutMs it fails after 10 s.
it('fails an until without timeoutMs after 10 s, saying what it saw', async () => {
  const { drive } = await serve()
  const begin = performance.now()
  await expect(drive([{ until: { event: 'workspaces.landed' } }])).rejects.toThrow(
    /Timed out after [\d.]+s: no matching workspaces.landed event/,
  )
  expect(performance.now() - begin).toBeGreaterThan(9_000)
  expect(performance.now() - begin).toBeLessThan(30_000)
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
