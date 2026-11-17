import { expect, it } from 'vitest'
import { itemOf } from '../../item.ts'
import type { UpdateState } from '../../refs.ts'

const state = (extra: Partial<UpdateState> = {}): UpdateState => ({
  root: '/clone',
  behind: 0,
  commits: [],
  install: false,
  restart: false,
  ...extra,
})
const layers = { core: false, bin: false, lockfile: false, live: true }

it('shows the quiet item while the clone is current', () => {
  expect(itemOf(state())).toBe('current')
  // An update that touched only hot-reloading code owes nothing: current again.
  expect(
    itemOf(
      state({
        updated: { ok: true, from: 'a', to: 'b', commits: 1, layers, install: 'skipped' },
      }),
    ),
  ).toBe('current')
})

it('shows nothing on a preview, and the prominent items while something is owed', () => {
  expect(itemOf(state({ preview: true }))).toBe('none')
  expect(itemOf(state({ behind: 3 }))).toBe('behind')
  expect(itemOf(state({ behind: 3, refused: 'dirty' }))).toBe('behind')
  expect(itemOf(state({ install: true }))).toBe('install')
  expect(itemOf(state({ restart: true }))).toBe('restart')
  expect(
    itemOf(
      state({
        updated: {
          ok: true,
          from: 'a',
          to: 'b',
          commits: 1,
          layers: { ...layers, core: true },
          install: 'skipped',
        },
      }),
    ),
  ).toBe('restart')
})
