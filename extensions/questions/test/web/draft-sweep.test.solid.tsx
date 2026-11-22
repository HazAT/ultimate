import { expect, it, vi } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { writerNow } from '../../../../web/src/sdk/writer.ts'
import { CrossSurfaceDraftSweep } from '../../sweep.solid.tsx'

const writes = vi.hoisted(() => [] as { source: string; cards: unknown }[])
vi.mock('@/sdk/solid', async () => ({
  ROOT: 1,
  useDocOf: () => () => ({
    messages: [{ id: 5, from: 2, to: 'user', reply: true, state: 'answered' }],
  }),
  useUiState: () => [
    () => ({ 'message:5': {} }),
    (cards: unknown) => writes.push({ source: writerNow(), cards }),
  ],
  writingAs: (await import('../../../../web/src/sdk/writer.ts')).writingAs,
}))

it('sweeps a settled question’s draft as the app, not as a person', () => {
  renderSolid(() => <CrossSurfaceDraftSweep />)
  expect(writes).toEqual([{ source: 'app', cards: {} }])
})
