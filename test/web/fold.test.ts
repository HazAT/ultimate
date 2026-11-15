import type { ConversationId } from '@earendil-works/pi-durable'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import { Fold, foldKey, writeFold } from '../../web/src/app/fold.tsx'

const state = vi.hoisted(() => ({ compact: false, conversation: 7 }))
vi.mock('../../web/src/sdk/hooks.ts', () => ({
  useCompact: () => (state.compact ? () => true : undefined),
  useConversation: (select: (conversation: { id: number }) => unknown) =>
    select({ id: state.conversation }),
}))

const stored = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  removeItem: (key: string) => stored.delete(key),
})
beforeEach(() => stored.clear())

/** What the reader sees of card `card`: its folded line (`closed`/`open`) or none, and whether the card shows. */
function look(card: string | number, keep?: boolean) {
  const html = renderToStaticMarkup(
    createElement(Fold, {
      card,
      keep,
      summary: 'Message to #4',
      children: createElement('section', null, 'the card'),
    }),
  )
  return {
    fold: /data-fold="(\w+)"/.exec(html)?.[1] ?? 'none',
    expanded: /aria-expanded="(\w+)"/.exec(html)?.[1],
    card: html.includes('<section>the card</section>'),
  }
}

it('leaves a card whole outside compact mode', () => {
  state.compact = false
  expect(look(12)).toEqual({ fold: 'none', expanded: undefined, card: true })
})

it('folds a card to its line in compact mode, with a button that says it is closed', () => {
  state.compact = true
  expect(look(12)).toEqual({ fold: 'closed', expanded: 'false', card: false })
})

it('never folds a card kept open, such as a user review', () => {
  state.compact = true
  expect(look(12, true)).toEqual({ fold: 'none', expanded: undefined, card: true })
})

it('keeps an opened card open across renders, per conversation and card, storing only the opened ones', () => {
  state.compact = true
  writeFold(foldKey(7 as ConversationId, 'call-1'), true)
  expect(look('call-1')).toEqual({ fold: 'open', expanded: 'true', card: true })
  expect(look('call-2').fold).toBe('closed')
  state.conversation = 8
  expect(look('call-1').fold).toBe('closed')
  state.conversation = 7
  writeFold(foldKey(7 as ConversationId, 'call-1'), false)
  expect(look('call-1').fold).toBe('closed')
  expect([...stored.keys()]).toEqual([])
})
