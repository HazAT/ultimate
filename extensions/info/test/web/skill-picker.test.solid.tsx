import type { ConversationId } from '@earendil-works/pi-durable'
import { createAgent } from '@ui-sdk/solid/agent'
import { settle } from '@ui-sdk/core/testing'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import type { SystemInfo } from '../../../../shared/protocol.ts'
import { FakeSource } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

const sources = vi.hoisted(() => [] as FakeSource[])
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const store = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      sources.push(stream)
      return stream
    },
    fetch: async () => Response.json({ ok: true, refused: {} }),
  })
  return { store, uiState: createUiState(undefined), api: {} }
})

import { store } from '../../../../web/src/sdk/client.ts'
import { getDraft } from '../../../../web/src/app/drafts.ts'
import { ConversationScope } from '../../../../web/src/sdk/solid.ts'
import { SkillPicker, skillDialog } from '../../skill-picker.solid.tsx'

const agent = createAgent()
const skill = (name: string, description: string) => ({
  name,
  description,
  path: `/skills/${name}/SKILL.md`,
  scope: 'project',
  manual: false,
  overrides: [],
})

it('lets an agent find a skill by its description and fill the composer with it', async () => {
  const main = 7 as ConversationId
  const side = 8 as ConversationId
  store.start()
  sources[0].open()
  sources[0].send('system', {
    process: { pid: 1, generation: 1, booted: 0 },
    skills: [
      skill('verify-ui', 'Check a UI change with screenshots'),
      skill('write-extension', 'Build or change an extension'),
      skill(
        'how-ultimate-works',
        'Walk a new user through five short beats, each ending with a card, before setup',
      ),
    ],
  } as unknown as SystemInfo)
  const container = renderSolid(() => (
    <>
      <button type="button">Open the palette</button>
      <button type="button">Open it again</button>
      <div inert>
        <textarea aria-label="Composer" data-conversation={main} id="composer-input" />
      </div>
      <div data-composer-target>
        <textarea aria-label="Side chat composer" data-conversation={side} />
      </div>
      <SkillPicker />
    </>
  ))
  container.querySelector('button')!.focus()
  store.setUi({ dialogs: { [skillDialog]: true } })
  flush()
  await settle()
  const input = agent.snapshot().find((item) => !item.offPage && item.label === 'Find a skill')
  expect(input?.actions).toEqual(expect.arrayContaining(['setQuery', 'run']))
  const search = await agent.act({
    steps: [{ ref: input!.ref, action: 'setQuery', args: ['screenshots'] }],
  })
  expect(search.ok).toBe(true)
  flush()
  await settle()
  const highlighted = container.querySelector('[data-slot="command-item"][data-highlighted]')
  expect(highlighted?.textContent ?? '').toContain('verify-ui')
  const nonmatching = [
    ...container.querySelectorAll<HTMLElement>('[data-slot="command-item"]'),
  ].find((item) => item.textContent?.includes('write-extension'))
  expect(!nonmatching || nonmatching.hidden).toBe(true)
  await agent.act({ steps: [{ ref: input!.ref, action: 'setQuery', args: ['verif'] }] })
  flush()
  await settle()
  const shown = [...container.querySelectorAll<HTMLElement>('[data-slot="command-item"]')]
    .filter((item) => !item.hidden)
    .map((item) => item.querySelector('.text-brand')?.textContent)
  expect(shown).toEqual(['verify-ui'])
  const result = await agent.act({ steps: [{ ref: input!.ref, action: 'run' }] })
  expect(result.ok).toBe(true)
  flush()
  await settle()
  expect(getDraft(side).get().text).toBe('/skill:verify-ui ')
  expect(getDraft(main).get().text).toBe('')
  expect(store.getState().ui.dialogs[skillDialog]).toBe(false)
  expect(container.querySelector('[role="dialog"][data-open]')).toBeNull()
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Side chat composer')

  const again = container.querySelectorAll('button')[1]
  again.focus()
  store.setUi({ dialogs: { [skillDialog]: true } })
  flush()
  await settle()
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Find a skill')
  document.activeElement!.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  )
  flush()
  await settle()
  expect(store.getState().ui.dialogs[skillDialog]).toBe(false)
  expect(document.activeElement).toBe(again)
  store.stop()
})

it('fills the current conversation’s draft on a surface without a composer', async () => {
  const current = 9 as ConversationId
  store.start()
  sources.at(-1)!.open()
  sources.at(-1)!.send('system', {
    process: { pid: 1, generation: 2, booted: 0 },
    skills: [skill('verify-ui', 'Check a UI change with screenshots')],
  } as unknown as SystemInfo)
  renderSolid(() => (
    <ConversationScope value={current}>
      <SkillPicker />
    </ConversationScope>
  ))
  store.setUi({ dialogs: { [skillDialog]: true } })
  flush()
  await settle()
  const input = agent.snapshot().find((item) => !item.offPage && item.label === 'Find a skill')
  const result = await agent.act({
    steps: [{ ref: input!.ref, action: 'run', args: ['verify-ui'] }],
  })
  expect(result.ok).toBe(true)
  flush()
  await settle()
  expect(getDraft(current).get().text).toBe('/skill:verify-ui ')
  expect(store.getState().ui.dialogs[skillDialog]).toBe(false)
  store.stop()
})
