import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { ConversationRef } from '../../extensions/conversations/feature.tsx'

const state = vi.hoisted(() => ({
  features: {} as Record<string, { feature?: string }>,
  titles: [] as { id: number; title?: string; label?: string }[],
}))
vi.mock('@/sdk', () => ({
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  useDocOf: () => ({ conversations: state.features }),
  useConversations: () => state.titles,
  useConversationSummary: (id?: number) =>
    state.titles.find((item: { id: number }) => item.id === id),
}))

/** The text a person reads, and which part of it is the gray `#id`. */
function read(props: { id: number; title?: string }) {
  const html = renderToStaticMarkup(createElement(ConversationRef, props))
  return {
    text: html
      .replaceAll(/<[^>]+>/g, ' ')
      .replaceAll(/\s+/g, ' ')
      .trim(),
    tag: /data-feature="([^"]*)"/.exec(html)?.[1],
    grayId: /<span class="[^"]*text-muted-foreground[^"]*">(#\d+)<\/span>/.exec(html)?.[1],
  }
}

it('names a conversation by its feature, then its id in gray', () => {
  state.features = { '7': { feature: 'Note Cards' } }
  state.titles = [{ id: 7, title: 'Give Notes a Yellow Look' }]
  expect(read({ id: 7 })).toEqual({ text: 'Note Cards #7', tag: 'Note Cards', grayId: '#7' })
})

it('falls back to the live title, then to the id alone', () => {
  state.features = {}
  state.titles = [{ id: 7, title: 'Give Notes a Yellow Look' }]
  expect(read({ id: 7 })).toEqual({
    text: 'Give Notes a Yellow Look #7',
    tag: undefined,
    grayId: '#7',
  })
  expect(read({ id: 8 })).toEqual({ text: '#8', tag: undefined, grayId: '#8' })
})

it('names a standing agent by its @name alone, whatever feature or title it carries', () => {
  state.features = { '43': { feature: 'Chat Cards' } }
  state.titles = [{ id: 43, title: '@ultimate', label: 'agent' }]
  expect(read({ id: 43, title: 'Fold cards in the chat' })).toEqual({
    text: '@ultimate #43',
    tag: undefined,
    grayId: '#43',
  })
})

it('shows a given title after the feature, and instead of the live one', () => {
  state.features = { '7': { feature: 'Note Cards' } }
  state.titles = [{ id: 7, title: 'Live Title' }]
  expect(read({ id: 7, title: 'Title When It Finished' }).text).toBe(
    'Note Cards Title When It Finished #7',
  )
  state.features = {}
  expect(read({ id: 7, title: 'Title When It Finished' }).text).toBe('Title When It Finished #7')
})
