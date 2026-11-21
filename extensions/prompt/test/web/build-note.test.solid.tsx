/** @jsxImportSource @solidjs/web */
import type { EntryRecord, ConversationId } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { Note } from '../../note.solid.tsx'
import type { BuildNote } from '../../refs.ts'

function renderNote(data: BuildNote) {
  const entry = { data } as EntryRecord
  return renderSolid(() => <Note core={null} entry={entry} />)
}

const text = (node: HTMLElement) => node.textContent.replaceAll(/\s+/g, ' ').trim()

it('names the first two landings and counts the rest, the build ids only on hover', () => {
  const landed = [
    { conversation: 60 as ConversationId, title: 'Skills chip', sha: 'c'.repeat(40) },
    { title: 'hand edit', sha: 'd'.repeat(40) },
    { conversation: 40 as ConversationId, title: 'Answer card redesign', sha: 'e'.repeat(40) },
  ]
  const note = renderNote({ from: 'b1aaaaaaaa', to: 'b2bbbbbbbb', landed })
  expect(text(note)).toMatch(/^Reloaded\s*·\s*Skills chip\s*#60\s*·\s*hand edit\s*·\s*\+1 more$/)
  expect(text(note)).not.toContain('b1aaaaa')
  expect(note.querySelector('button')?.getAttribute('aria-label')).toBe('Open #60')
})

it('keeps the build ids when nothing landed', () => {
  expect(text(renderNote({ from: 'b1aaaaaaaa', to: 'b2bbbbbbbb' }))).toMatch(
    /^Reloaded\s*·\s*build b1aaaaa → b2bbbbb$/,
  )
})
