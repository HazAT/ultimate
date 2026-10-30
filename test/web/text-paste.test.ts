import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FoldedText } from '../../web/src/app/folded-text.tsx'
import {
  deletePasteAt,
  expandPastes,
  insertPaste,
  overLimit,
  pasteMarker,
} from '../../web/src/app/text-paste.ts'
import type { Paste } from '../../web/src/app/text-paste.ts'

// The rendered message's chips are not what this file is about.
vi.mock('@/components/ai/message', () => ({
  MentionText: ({ text }: { text: string }) => text,
}))

const blockOf = (lines: number, mark: string) =>
  Array.from({ length: lines }, (_, line) => `${mark} line ${line + 1}`).join('\n')

/** The editor after pasting `blocks` one after another at the caret. */
function pasting(...blocks: string[]) {
  let state = { text: '', pastes: [] as Paste[], caret: 0 }
  for (const block of blocks)
    state = insertPaste(state.text, state.caret, state.caret, block, state.pastes)
  return state
}

describe('overLimit', () => {
  it('folds past 8 lines or past 800 characters, and leaves a text that reaches neither as typed', () => {
    expect(overLimit('a'.repeat(800))).toBe(false)
    expect(overLimit('a'.repeat(801))).toBe(true)
    expect(overLimit(blockOf(8, 'x'))).toBe(false)
    expect(overLimit(blockOf(9, 'x'))).toBe(true)
  })
})

describe('a large paste', () => {
  it('stands in the editor as a short marker and takes its place again on send', () => {
    const block = blockOf(120, 'csv')
    const pasted = insertPaste('read this:\n', 11, 11, block, [])
    expect(pasted.text).toBe('read this:\n[paste #1 +120 lines]')
    expect(pasted.caret).toBe(pasted.text.length)
    expect(expandPastes(pasted.text, pasted.pastes)).toBe(`read this:\n${block}`)
  })

  it('states a paste that fits on one line in characters, and keeps a typed marker of an unknown paste', () => {
    expect(pasteMarker({ id: 2, text: 'a'.repeat(900) })).toBe('[paste #2 900 chars]')
    expect(expandPastes('[paste #7 +3 lines]', pasting('x').pastes)).toBe('[paste #7 +3 lines]')
  })
})

describe('deleting a marker', () => {
  const blocks = ['first', 'second', 'third'].map((mark) => blockOf(9, mark))
  const pasted = pasting(...blocks)
  const secondAt = pasted.text.indexOf('[paste #2')
  const secondEnd = secondAt + '[paste #2 +9 lines]'.length

  it('removes that block whole and numbers the later pastes down, so each still expands to its own text', () => {
    const removed = deletePasteAt(pasted.text, secondEnd, 'backward', pasted.pastes)
    expect(removed?.text).toBe('[paste #1 +9 lines][paste #2 +9 lines]')
    expect(removed?.caret).toBe(secondAt)
    expect(removed?.pastes.map((paste) => paste.id)).toEqual([1, 2])
    expect(expandPastes(removed!.text, removed!.pastes)).toBe(`${blocks[0]}${blocks[2]}`)
  })

  it('takes the marker after the caret with forward delete, and nothing when the caret touches none', () => {
    expect(deletePasteAt(pasted.text, secondAt, 'forward', pasted.pastes)?.text).toBe(
      '[paste #1 +9 lines][paste #2 +9 lines]',
    )
    expect(deletePasteAt(pasted.text, secondAt + 2, 'backward', pasted.pastes)).toBeUndefined()
    expect(deletePasteAt(pasted.text, secondAt + 2, 'forward', pasted.pastes)).toBeUndefined()
  })
})

describe('a sent message', () => {
  const long = blockOf(124, 'log')
  const render = (text: string) => renderToStaticMarkup(createElement(FoldedText, { text }))

  it('shows three lines of a long one with its size, and opens it on demand', () => {
    const html = render(long)
    expect(html).toContain('line-clamp-3')
    expect(html).toContain('124 lines · show')
    expect(html).toContain('aria-expanded="false"')
  })

  it('shows a short one whole, with no toggle', () => {
    const html = render('one line, as typed')
    expect(html).toContain('<p class="whitespace-pre-wrap">one line, as typed</p>')
    expect(html).not.toContain('<button')
  })
})
