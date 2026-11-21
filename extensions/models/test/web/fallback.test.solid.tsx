/** @jsxImportSource @solidjs/web */
import type { EntryRecord } from '@earendil-works/pi-durable'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import type { Component } from 'solid-js'
import { expect, it } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { store } from '../../../../web/src/sdk/client.ts'
import type { SolidEntryProps } from '../../../../web/src/sdk/types.ts'
import { dialogs, pickerTarget } from '../../state.ts'
import models from '../../web.solid.tsx'

const agent = createAgent()

it('opens the model picker for the fallback entry’s conversation', async () => {
  const conversationId = parseConversationId(17)
  const entry = {
    conversationId,
    kind: 'models.fallback',
    data: { from: 'faux/atlas', to: 'other/atlas', reason: 'same' },
  } as unknown as EntryRecord
  const Fallback = models.entries?.['models.fallback'] as Component<SolidEntryProps>
  renderSolid(() => <Fallback core={null} entry={entry} />)
  flush()
  await expectDistinctAgentNames(agent)
  const button = agent
    .snapshot()
    .find((control) => !control.offPage && control.label === 'Pick another model')
  expect(button).toBeDefined()
  expect(store.getState().ui.dialogs[dialogs.picker]).toBeFalsy()
  const result = await agent.act({ steps: [{ ref: button!.ref, action: 'press' }] })
  expect(result.ok).toBe(true)
  expect(store.getState().ui.dialogs[dialogs.picker]).toBe(true)
  expect(pickerTarget.get()).toBe(conversationId)
})
