import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import {
  mentionHref,
  parseMention,
  remarkMentions,
  splitMentions,
} from '../../web/src/components/ai/mentions.ts'

const known = vi.hoisted(() => [{ id: 157029, title: 'Sidebar polish landed' }])
vi.mock('@/sdk', () => ({
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  events: { emit: () => {} },
  useDocOf: () => ({ conversations: { '157029': { feature: 'Sidebar' } } }),
  useConversations: () => known,
  useConversationSummary: (id?: number) => known.find((item: { id: number }) => item.id === id),
  useUltimate: () => ({ switchConversation: () => {}, showSurface: () => {} }),
}))
const { MentionLink } = await import('../../extensions/conversations/mention.tsx')

const mentions = (text: string) =>
  splitMentions(text).flatMap((part) => (typeof part === 'string' ? [] : [part.text]))

it('finds conversation mentions and breadcrumbs in running text', () => {
  expect(mentions('I reopened #157029, then #157833/158003 (and #30726).')).toEqual([
    '#157029',
    '#157833/158003',
    '#30726',
  ])
})

it('leaves short numbers, words, paths, URLs and entities alone', () => {
  expect(
    mentions(
      '#1 priority, issue #12, a#157029, x/#157029, https://h.dev/p#157029, &#160;, #157029x, ##157029, #157/a',
    ),
  ).toEqual([])
})

it('round-trips a mention through its href', () => {
  expect(parseMention(mentionHref('157029'))).toEqual({ conversation: 157029, entry: undefined })
  expect(parseMention(mentionHref('157029', '158003'))).toEqual({
    conversation: 157029,
    entry: 158003,
  })
  expect(parseMention('https://example.com/?conversation=1')).toBeUndefined()
})

type Node = { type: string; value?: string; url?: string; children?: Node[] }
const text = (value: string): Node => ({ type: 'text', value })

it('turns text mentions into links but never inside code or existing links', () => {
  const tree: Node = {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [text('see #157029 and '), { type: 'inlineCode', value: '#157833' }],
      },
      { type: 'code', value: 'echo #157833' },
      { type: 'link', url: 'https://x.dev', children: [text('#157833')] },
    ],
  }
  remarkMentions()(tree)
  expect(tree.children?.[0]?.children).toEqual([
    text('see '),
    { type: 'link', url: '#conversation-157029', children: [text('#157029')] },
    text(' and '),
    { type: 'inlineCode', value: '#157833' },
  ])
  expect(tree.children?.[1]).toEqual({ type: 'code', value: 'echo #157833' })
  expect(tree.children?.[2]?.children).toEqual([text('#157833')])
})

it('renders a known mention as its chip and an unknown one as its text', () => {
  const chip = renderToStaticMarkup(
    createElement(MentionLink, {
      href: mentionHref('157029', '158003'),
      children: '#157029/158003',
      core: 'core',
    }),
  )
  expect(chip).toContain('data-conversation-mention="157029"')
  expect(chip).toContain('data-feature="Sidebar"')
  expect(chip).toContain('/158003')
  const unknown = renderToStaticMarkup(
    createElement(MentionLink, {
      href: mentionHref('999999'),
      children: '#999999',
      core: '#999999',
    }),
  )
  expect(unknown).toBe('#999999')
})
