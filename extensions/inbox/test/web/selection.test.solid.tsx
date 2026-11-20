/** @jsxImportSource @solidjs/web */
import { createElement as h, act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import { createUiState } from '../../../../web/src/sdk/ui-state.ts'
import { SELECTED, UNLOADED } from '../../items.ts'
import { useSelection } from '../../selection.tsx'
import type { Entry, Selection } from '../../items.ts'

const harness = vi.hoisted(() => ({
  writes: [] as unknown[],
  failures: 0,
  rejections: 0,
  store: undefined as unknown,
}))
vi.mock('../../../../web/src/sdk/client.ts', () => ({
  get uiState() {
    return harness.store
  },
}))

const freshStore = () =>
  createUiState(
    async (request) => {
      harness.writes.push(request.ops[0].value)
      if (harness.failures < harness.rejections) throw new Error('server down')
      return { ok: true, rev: harness.writes.length }
    },
    { delayMs: 0, onError: () => harness.failures++ },
  )

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const entry = (key: string, at: number) => ({ key, at }) as Entry
const [a, b] = [entry('a', 10), entry('b', 20)]

let page: ReturnType<typeof load>
function load() {
  const uiState = harness.store as ReturnType<typeof freshStore>
  let select: (next: Selection) => void = () => undefined
  function Probe({ entries }: { entries: Entry[] }) {
    select = useSelection(entries).setSelected
    return null
  }
  const settled = async () => {
    for (let round = 0; round < 3; round++) await act(() => uiState.flush())
  }
  const root = createRoot(document.createElement('div'))
  const show = async (entries: Entry[]) => {
    await act(async () => root.render(h(Probe, { entries })))
    await settled()
  }
  const choose = async (next: Selection) => {
    await act(async () => select(next))
    await settled()
  }
  return { uiState, root, show, choose }
}

beforeEach(({ onTestFinished }) => {
  Object.assign(harness, { writes: [], failures: 0, rejections: 0, store: freshStore() })
  page = load()
  onTestFinished(() => page.root.unmount())
})

it('sends a rejected handoff once while mounted, and once more after a remount', async () => {
  harness.rejections = 4
  page.uiState.receive({ [SELECTED]: { key: 'b', at: 20, open: true } })
  await page.show([a])
  expect(harness.writes).toEqual([{ key: 'a', at: 10, open: true }])
  expect(harness.failures).toBe(1)
  page.root.unmount()
  const remounted = load()
  await remounted.show([a])
  expect(harness.writes).toHaveLength(2)
  remounted.root.unmount()
})

it('sends a rejected repair of a late link’s age once while mounted', async () => {
  harness.rejections = 4
  page.uiState.receive({ [SELECTED]: { key: 'b', at: UNLOADED, open: true } })
  await page.show([a, b])
  expect(harness.writes).toEqual([{ key: 'b', at: 20, open: true }])
  expect(harness.failures).toBe(1)
})

it('repairs a second link to the same entry after the selection moved elsewhere', async () => {
  page.uiState.receive({ [SELECTED]: { key: 'b', at: UNLOADED, open: true } })
  await page.show([a, b])
  expect(harness.writes).toEqual([{ key: 'b', at: 20, open: true }])
  await page.choose({ key: 'a', at: 10, open: true })
  await page.show([a])
  await page.choose({ key: 'b', at: UNLOADED, open: true })
  await page.show([a, b])
  expect(harness.writes.at(-1)).toEqual({ key: 'b', at: 20, open: true })
  expect(page.uiState.get(SELECTED)).toEqual({ key: 'b', at: 20, open: true })
})

it('hands off again when the same entry comes back, is selected, and leaves again', async () => {
  await page.show([a, b])
  await page.choose({ key: 'b', at: 20, open: true })
  await page.show([a])
  await page.show([a, b])
  await page.choose({ key: 'b', at: 20, open: true })
  await page.show([a])
  expect(harness.writes.filter((value) => (value as Selection)?.key === 'a')).toHaveLength(2)
  expect(page.uiState.get(SELECTED)).toEqual({ key: 'a', at: 10, open: true })
})
