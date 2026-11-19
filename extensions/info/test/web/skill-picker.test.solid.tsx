/** @jsxImportSource @solidjs/web */
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
    fetch: async () => Response.json({ ok: true }),
  })
  return { store, uiState: createUiState(undefined), api: {} }
})

import { store } from '../../../../web/src/sdk/client.ts'
import { ConversationScope } from '../../../../web/src/sdk/solid.ts'
import { getDraft } from '../../../../web/src/app/drafts.ts'
import { SkillPicker, skillDialog } from '../../skill-picker.solid.tsx'

const skill = (name: string, description: string) => ({
  name,
  description,
  path: `/skills/${name}/SKILL.md`,
  scope: 'project',
  manual: false,
  overrides: [],
})

it('lets an agent find a skill by its description and fill the composer with it', async () => {
  const conversation = 7 as ConversationId
  store.start()
  sources[0].open()
  sources[0].send('system', {
    process: { pid: 1, generation: 1, booted: 0 },
    skills: [
      skill('verify-ui', 'Check a UI change with screenshots'),
      skill('write-extension', 'Build or change an extension'),
    ],
  } as unknown as SystemInfo)
  store.setUi({ dialogs: { [skillDialog]: true } })
  const container = renderSolid(() => (
    <ConversationScope value={conversation}>
      <SkillPicker />
    </ConversationScope>
  ))
  flush()
  await settle()
  const agent = createAgent()
  const input = agent.snapshot().find((item) => item.label === 'Find a skill')
  expect(input?.actions).toEqual(expect.arrayContaining(['setQuery', 'run']))
  const result = await agent.act({
    steps: [
      { ref: input!.ref, action: 'setQuery', args: ['screenshots'] },
      { ref: input!.ref, action: 'run', args: ['verify-ui'] },
    ],
  })
  expect(result.ok).toBe(true)
  flush()
  await settle()
  expect(getDraft(conversation).get().text).toBe('/skill:verify-ui ')
  expect(store.getState().ui.dialogs[skillDialog]).toBe(false)
  expect(container.querySelector('[role="dialog"][data-open]')).toBeNull()
  store.stop()
})
