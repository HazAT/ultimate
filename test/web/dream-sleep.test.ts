import { createElement } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ busy: [] as { id: number; title: string }[] }))
vi.mock('@/sdk', () => ({
  Card: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
  formatTime: () => 'now',
  useSystem: () => undefined,
  useUltimate: () => ({}),
}))
vi.mock('@/components/ai/message', () => ({
  MessageResponse: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('../../extensions/dream/chapters.tsx', () => ({
  BusyBlocker: ({ busy }: { busy: { id: number; title: string }[] }) =>
    createElement('div', null, busy.map((item) => item.title).join(', ')),
  CHAPTER_NAME: /^[a-z0-9][a-z0-9-]{0,39}$/,
  chapterLabel: (number: number, name: string) => `Chapter ${number} · ${name}`,
  fallAsleep: () => Promise.resolve(undefined),
  useBusyElsewhere: () => state.busy,
  useChapters: () => ({ chapters: [] }),
}))
const { NextChapter } = await import('../../extensions/dream/sleep.tsx')
const render = () =>
  renderToStaticMarkup(
    createElement(NextChapter, {
      prepared: { chapter: 'fresh-start', at: 0, learned: ['One', 'Two', 'Three'], handoff: '' },
    }),
  )

it('explains the wait and leaves Fall asleep disabled until the conversations finish', () => {
  state.busy = [{ id: 2, title: 'Work in progress' }]
  const blocked = render()
  expect(blocked).toContain('Work in progress')
  expect(blocked).toContain('This wait clears automatically when they finish.')
  expect(blocked).toContain('Then press Fall asleep to switch')
  expect(blocked).toMatch(/data-dream-asleep="true"[^>]*disabled/)

  state.busy = []
  const ready = render()
  expect(ready).not.toContain('This wait clears automatically')
  expect(ready).not.toMatch(/data-dream-asleep="true"[^>]*disabled/)
})
