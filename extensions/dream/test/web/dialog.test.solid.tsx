import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { store } from '../../../../web/src/sdk/client.ts'
import { writerNow } from '../../../../web/src/sdk/writer.ts'
import { DreamDialog, dreamDialog } from '../../modal.solid.tsx'
import { StartAction } from '../../refs.ts'

const { act, talk } = vi.hoisted(() => ({
  act: vi.fn<(ref: typeof StartAction, args: null) => Promise<void>>(),
  talk: vi.fn<() => Promise<string>>(),
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  return { store: createStore(), uiState: createUiState(undefined), api: { action: act } }
})
vi.mock('../../../subagents/ui.solid.tsx', () => ({ talkToUltimate: talk }))

const agent = createAgent()

it('keeps the dream dialog open on refusal, then starts and opens the standing conversation', async () => {
  act.mockRejectedValueOnce(new Error('Already dreaming')).mockResolvedValueOnce(undefined)
  talk.mockImplementationOnce(() => Promise.resolve(writerNow()))
  store.setUi({ dialogs: { [dreamDialog]: true } })
  const container = renderSolid(() => <DreamDialog />)
  expect(container.textContent).toContain('Six passes')
  await expectDistinctAgentNames(agent)
  const start = agent.snapshot().find((item) => !item.offPage && item.label === 'Start dreaming')
  expect(await agent.act({ steps: [{ ref: start!.ref, action: 'press' }] })).toMatchObject({
    ok: true,
  })
  flush()
  expect(container.textContent).toContain('Already dreaming')
  expect(talk).not.toHaveBeenCalled()
  expect(await agent.act({ steps: [{ ref: start!.ref, action: 'press' }] })).toMatchObject({
    ok: true,
  })
  flush()
  expect(container.textContent).not.toContain('Six passes')
  expect(act).toHaveBeenLastCalledWith(StartAction, null)
  expect(talk).toHaveBeenCalledOnce()
  await expect(talk.mock.results[0].value).resolves.toBe('agent')
})
