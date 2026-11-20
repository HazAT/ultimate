/** @jsxImportSource @solidjs/web */
import { expect, it, vi } from 'vitest'
import { MentionLink } from '../../extensions/conversations/mention.solid.tsx'
import {
  mentionHref,
  parseMention,
  remarkMentions,
  splitMentions,
} from '../../web/src/components/ai/mentions.ts'
import { renderSolid } from './solid-dom-setup.ts'

const { openEntry, switchConversation, showSurface } = vi.hoisted(() => ({
  openEntry: vi.fn<(event: string, data: unknown) => void>(),
  switchConversation: vi.fn<(id: number) => void>(),
  showSurface: vi.fn<(surface: string) => void>(),
}))
vi.mock('@/sdk/solid', () => ({
  ROOT: 1,
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  events: { emit: openEntry },
  useDocOf: () => () => ({ conversations: { 157029: { feature: 'Sidebar' } } }),
  useConversations: () => () => [{ id: 157029, title: 'Sidebar polish landed' }],
  switchConversation,
  showSurface,
}))

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
  const known = renderSolid(() => (
    <MentionLink core="core" href={mentionHref('157029', '158003')}>
      #157029/158003
    </MentionLink>
  ))
  const chip = known.querySelector<HTMLAnchorElement>('a[data-conversation-mention="157029"]')!
  expect(chip.querySelector('[data-feature="Sidebar"]')).not.toBeNull()
  expect(chip.textContent).toContain('/158003')
  expect(chip.title).toBe('Open #157029 at entry 158003: Sidebar polish landed')
  chip.click()
  expect(openEntry).toHaveBeenCalledExactlyOnceWith('messages:open', {
    conversation: 157029,
    entry: 158003,
  })
  expect(showSurface).toHaveBeenCalledExactlyOnceWith('agent')
  expect(switchConversation).toHaveBeenCalledExactlyOnceWith(157029)

  const unknown = renderSolid(() => (
    <MentionLink core="#999999" href={mentionHref('999999')}>
      #999999
    </MentionLink>
  ))
  expect(unknown.textContent).toBe('#999999')
  expect(unknown.querySelector('a')).toBeNull()
})
