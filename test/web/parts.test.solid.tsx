import { createAgent } from '@ui-sdk/solid/agent'
import { createStore as createSolidStore, flush, useContext } from 'solid-js'
import { expect, it, vi } from 'vitest'

vi.mock('../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../web/src/sdk/store.ts')
  const { createRegistry } = await import('../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../web/src/sdk/ui-state.ts')
  return {
    store: createStore(),
    registry: createRegistry(),
    uiState: createUiState(undefined),
    api: {},
    reportCompact: () => {},
  }
})

import { Fold } from '../../web/src/app/fold.solid.tsx'
import { Button } from '../../web/src/components/ui/button.solid.tsx'
import { registry } from '../../web/src/sdk/client.ts'
import { ExtensionName, Provided } from '../../web/src/sdk/solid.ts'
import { definePoint } from '../../web/src/sdk/types.ts'
import { renderSolid } from './solid-dom-setup.ts'

const provision = (point: { point: string }, use: unknown) => ({ point: point.point, use })

const agent = createAgent()

it('opens a transcript fold from the bridge and remembers it after remount', async () => {
  const fold = () => (
    <Fold always card="agent-fold-test" label="Tool details for this call" summary="Tool summary">
      Tool output
    </Fold>
  )
  const container = renderSolid(fold)
  const control = agent
    .snapshot()
    .find((entry) => !entry.offPage && entry.label === 'Tool details for this call')
  expect(control).toMatchObject({ component: 'collapsible', open: false })
  expect(container.textContent).not.toContain('Tool output')
  expect(
    await agent.act({ steps: [{ ref: control!.ref, action: 'setOpen', args: [true] }] }),
  ).toMatchObject({ ok: true })
  const trigger = container.querySelector('button')!
  const body = document.getElementById(trigger.getAttribute('aria-controls')!)
  expect(body?.textContent).toBe('Tool output')
  expect(container.querySelector('[data-slot="collapsible-panel"]')).toBeNull()
  expect(renderSolid(fold).textContent).toContain('Tool output')
})

const Extras = definePoint<{ id: number }, unknown>('test.extras')

it('renders providers in discovery order and isolates a failing one', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const Chip = (props: { id: number }) => <b>chip {props.id}</b>
  const Detail = (props: { id: number }) => <i>{props.id < 0 ? fail() : `detail ${props.id}`}</i>
  const fail = () => {
    throw new Error('broke')
  }
  await registry.setLoaders({
    'extensions/a/web.solid.tsx': async () => ({
      default: { provides: [provision(Extras, Chip)] },
    }),
    'extensions/b/web.solid.tsx': async () => ({
      default: { provides: [provision(Extras, Detail)] },
    }),
  })
  const container = renderSolid(() => (
    <>
      <p data-all>
        <Provided input={{ id: 3 }} point={Extras} />
      </p>
      <p data-last>
        <Provided input={{ id: 4 }} last point={Extras} />
      </p>
      <div data-broken>
        <Provided input={{ id: -1 }} point={Extras} />
      </div>
    </>
  ))
  flush()
  const text = (selector: string) => container.querySelector(selector)?.textContent
  expect(text('[data-all]')).toBe('chip 3detail 3')
  expect(text('[data-last]')).toBe('detail 4')
  expect(text('[data-broken]')).toContain('chip -1')
  expect(container.querySelector('[data-broken] [data-extension-error="b"]')).not.toBeNull()
})

const Status = definePoint<{ message: { state: string }; onOpen?: () => void }, unknown>(
  'test.status',
)

it('keeps a provider scoped to its extension when a nested input changes in place', async () => {
  const Named = (props: { message: { state: string }; onOpen?: () => void }) => {
    const extension = useContext(ExtensionName)
    return (
      <Button onClick={props.onOpen}>
        {extension}:{props.message.state}
      </Button>
    )
  }
  await registry.setLoaders({
    'extensions/chip/web.solid.tsx': async () => ({
      default: { provides: [provision(Status, Named)] },
    }),
  })
  const opened = vi.fn<() => void>()
  const [board, setBoard] = createSolidStore({ message: { state: 'delivered' } })
  const container = renderSolid(() => (
    <Provided input={{ message: board.message, onOpen: opened }} point={Status} />
  ))
  flush()
  expect(container.textContent).toBe('chip:delivered')
  setBoard((draft) => {
    draft.message.state = 'answered'
  })
  flush()
  expect(container.textContent).toBe('chip:answered')
  container.querySelector('button')!.click()
  expect(opened).toHaveBeenCalledOnce()
})
