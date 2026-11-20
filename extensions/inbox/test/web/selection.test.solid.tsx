/** @jsxImportSource @solidjs/web */
import { createElement as h, act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { Entry } from '../../items.ts'

const harness = vi.hoisted(() => ({ writes: [] as unknown[], failures: 0, reject: true }))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  return {
    uiState: createUiState(
      async (request) => {
        harness.writes.push(request.ops[0].value)
        if (harness.reject && harness.writes.length < 5) throw new Error('server down')
        return { ok: true, rev: harness.writes.length }
      },
      { delayMs: 0, onError: () => harness.failures++ },
    ),
  }
})

import { uiState } from '../../../../web/src/sdk/client.ts'
import { SELECTED } from '../../items.ts'
import type { Selection } from '../../items.ts'
import { useSelection } from '../../selection.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const entry = (key: string, at: number) => ({ key, at }) as Entry
const [a, b] = [entry('a', 10), entry('b', 20)]
let select: (next: Selection) => void = () => undefined

function Probe({ entries }: { entries: Entry[] }) {
  select = useSelection(entries).setSelected
  return null
}

const settled = async () => {
  for (let round = 0; round < 3; round++) await act(() => uiState.flush())
}

async function mounted(entries: Entry[]) {
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(h(Probe, { entries })))
  await settled()
  return root
}

it('sends a rejected handoff once while mounted, and once more after a remount', async () => {
  uiState.receive({ [SELECTED]: { key: 'b', at: 20, open: true } })
  const first = await mounted([a])
  expect(harness.writes).toEqual([{ key: 'a', at: 10, open: true }])
  expect(harness.failures).toBe(1)
  first.unmount()
  const second = await mounted([a])
  expect(harness.writes).toHaveLength(2)
  expect(harness.failures).toBe(2)
  second.unmount()
})

it('hands off again when the same entry comes back, is selected, and leaves again', async () => {
  harness.reject = false
  harness.writes.length = 0
  const root = await mounted([a, b])
  await act(async () => select({ key: 'b', at: 20, open: true }))
  await act(async () => root.render(h(Probe, { entries: [a] })))
  await settled()
  await act(async () => root.render(h(Probe, { entries: [a, b] })))
  await act(async () => select({ key: 'b', at: 20, open: true }))
  await act(async () => root.render(h(Probe, { entries: [a] })))
  await settled()
  expect(harness.writes.filter((value) => (value as Selection)?.key === 'a')).toHaveLength(2)
  expect(uiState.get(SELECTED)).toEqual({ key: 'a', at: 10, open: true })
  root.unmount()
})
