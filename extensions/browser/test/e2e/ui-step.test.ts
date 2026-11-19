import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import browserExtension from '../../server.ts'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { context } from '../../../../server/harness.ts'
import { EventFeed } from '../../../../server/events.ts'
import type { ExtensionHost } from '../../../../server/extensions.ts'
import { ChangedEvent } from '../../../ui/refs.ts'
import { fauxServer, removeTemp, temp } from '../../../../test/helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

const panel = `/** @jsxImportSource @solidjs/web */
import { createSignal } from 'solid-js'
import { Switch, SwitchThumb } from '@ui-sdk/solid/switch'

export function Digest() {
  const [on, setOn] = createSignal(false)
  return (
    <Switch aria-label="Weekly digest" checked={on()} onCheckedChange={(value) => setOn(value)}>
      <SwitchThumb />
    </Switch>
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
  const recorded = async () =>
    ((await server.harness.snapshot(EventFeed, ROOT_CONVERSATION_ID, context))?.events ?? [])
      .filter((event) => ChangedEvent.is(event))
      .map((event) => event.data)
  return { drive, recorded }
}

const digest = { component: 'switch', label: 'Weekly digest', checked: false }

it('snapshots, queries and acts on ui-sdk controls from the first step, and records the agent’s change before the page closes', async () => {
  const { drive, recorded } = await serve()
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

  expect(await recorded()).toEqual([
    expect.objectContaining({
      component: 'switch',
      label: 'Weekly digest',
      key: 'checked',
      value: true,
      previous: false,
      source: 'agent',
      driven: true,
      device: expect.any(String),
    }),
  ])
})

it('drives ui-sdk controls with the ui extension off, and records nothing', async () => {
  const { drive, recorded } = await serve({ extensions: { disable: ['ui'] } })
  const value = await drive([
    { ui: 'act', steps: [{ ref: 'Weekly digest', action: 'setChecked', args: [true] }] },
    {
      eval: "document.querySelector('[aria-label=\"Weekly digest\"]').getAttribute('aria-checked')",
    },
  ])
  expect(value(1)).toMatchObject({ ok: true })
  expect(value(2)).toBe('true')
  expect(await recorded()).toEqual([])
})
