import { expect, it } from 'vitest'
import {
  added,
  draftsKey,
  dropComment,
  excerptOf,
  isUnsaved,
  limits,
  loadWriting,
  putComment,
  putNote,
  readDrafts,
  saveWriting,
  sendDrafts,
  sendProblem,
  typed,
  withoutSent,
  writingSlot,
} from '../comments.ts'
import type { Draft, DraftStorage, Drafts, Writing } from '../comments.ts'

const draft = (id: string, text = `comment ${id}`, start = 1): Draft => ({
  id,
  start,
  end: start,
  excerpt: 'x',
  anchor: 'x',
  text,
})

function storage() {
  const values = new Map<string, string>()
  const store: DraftStorage & { full: boolean; values: Map<string, string> } = {
    full: false,
    values,
    get length() {
      return values.size
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (store.full) throw new DOMException('quota', 'QuotaExceededError')
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
  return store
}

function tab(shared: ReturnType<typeof storage>) {
  const cache = storage()
  for (const [key, value] of shared.values) cache.values.set(key, value)
  const pending = new Map<string, string | null>()
  const view: DraftStorage = {
    get length() {
      return cache.length
    },
    key: cache.key,
    getItem: cache.getItem,
    setItem: (key, value) => {
      cache.setItem(key, value)
      pending.set(key, value)
    },
    removeItem: (key) => {
      cache.removeItem(key)
      pending.set(key, null)
    },
  }
  const flush = () => {
    for (const [key, value] of pending)
      if (value === null) shared.removeItem(key)
      else shared.setItem(key, value)
    pending.clear()
  }
  return { view, flush }
}

const PREFIX = draftsKey('/work/app/docs/plan.md')
const TAB = 'tab-a'

it('keeps both comments when two tabs write at once, each change touching only its own key', () => {
  const shared = storage()
  const a = tab(shared)
  const b = tab(shared)
  expect(putComment(draft('from-a', 'a', 3))(a.view, PREFIX)).toBe(true)
  expect(putComment(draft('from-b', 'b', 9))(b.view, PREFIX)).toBe(true)
  expect(putNote('note from b')(b.view, PREFIX)).toBe(true)
  b.flush()
  a.flush()
  expect(readDrafts(shared, PREFIX)).toEqual({
    comments: [draft('from-a', 'a', 3), draft('from-b', 'b', 9)],
    note: 'note from b',
  })
  const c = tab(shared)
  const d = tab(shared)
  putComment(draft('from-a', 'edited in c', 3))(c.view, PREFIX)
  dropComment('from-b')(d.view, PREFIX)
  d.flush()
  c.flush()
  expect(readDrafts(shared, PREFIX).comments).toEqual([draft('from-a', 'edited in c', 3)])
})

it("keeps each file's drafts apart by absolute path", () => {
  const shared = storage()
  putComment(draft('here'))(shared, PREFIX)
  putComment(draft('worktree copy'))(shared, draftsKey('/work/worktree/docs/plan.md'))
  putComment(draft('longer name'))(shared, draftsKey('/work/app/docs/plan.md:b.md'))
  shared.setItem(`${PREFIX}broken`, 'not json')
  expect(readDrafts(shared, PREFIX)).toEqual({ comments: [draft('here')], note: '' })
})

it('brings back the comment a tab was writing after an unmount, at its moved line, until it is added or cancelled', () => {
  const shared = storage()
  const lines = ['# H', '', 'First', '', 'Second']
  const open: Writing = { start: 5, end: 5, excerpt: 'Second', anchor: 'Second', text: '' }
  const refused = added(typed(open, 'Say why'), false)!
  expect(refused).toEqual({ ...open, text: 'Say why', refused: true })
  expect(saveWriting(refused, TAB)(shared, PREFIX)).toBe(true)
  saveWriting({ ...open, text: 'in another tab' }, 'tab-b')(shared, PREFIX)

  expect(loadWriting(shared, PREFIX, lines, TAB)).toEqual(refused)
  expect(loadWriting(shared, PREFIX, ['# H', '', 'First', '', '', '', 'Second'], TAB)?.start).toBe(
    7,
  )
  expect(readDrafts(shared, PREFIX)).toEqual({ comments: [], note: '' })
  expect(typed(refused, 'Say why, shorter')).toEqual({ ...open, text: 'Say why, shorter' })
  expect(added(refused, true)).toBeUndefined()

  saveWriting(undefined, TAB)(shared, PREFIX)
  expect(loadWriting(shared, PREFIX, lines, TAB)).toBeUndefined()
  expect(loadWriting(shared, PREFIX, lines, 'tab-b')?.text).toBe('in another tab')
})

it('holds a note or a comment being written in memory when storage is full, until a write of it saves', () => {
  const shared = storage()
  const lines = ['# H', '', 'Second']
  const writing: Writing = {
    start: 3,
    end: 3,
    excerpt: 'Second',
    anchor: 'Second',
    text: 'Typed while full',
  }
  putComment(draft('kept'))(shared, PREFIX)
  shared.full = true
  expect(saveWriting(writing, TAB)(shared, PREFIX)).toBe(false)
  expect(putNote('Note typed while full')(shared, PREFIX)).toBe(false)
  expect(putComment(draft('refused'))(shared, PREFIX)).toBe(false)

  expect([...shared.values.keys()]).toEqual([`${PREFIX}kept`])
  expect(loadWriting(shared, PREFIX, lines, TAB)).toEqual(writing)
  expect(readDrafts(shared, PREFIX)).toEqual({
    comments: [draft('kept')],
    note: 'Note typed while full',
  })
  expect(isUnsaved(shared, PREFIX, writingSlot(TAB))).toBe(true)
  expect(isUnsaved(shared, PREFIX, 'note')).toBe(true)

  shared.full = false
  expect(putNote('Note, saved')(shared, PREFIX)).toBe(true)
  expect(isUnsaved(shared, PREFIX, 'note')).toBe(false)
  expect(readDrafts(storage(), PREFIX).note).toBe('')
})

it('clears only what was sent once a send lands, keeping edits made meanwhile', () => {
  const shared = storage()
  const sent: Drafts = { comments: [draft('a'), draft('b')], note: 'overall' }
  for (const comment of [draft('a'), draft('b', 'edited while sending'), draft('c')])
    putComment(comment)(shared, PREFIX)
  putNote('overall, more')(shared, PREFIX)
  withoutSent(sent)(shared, PREFIX)
  expect(readDrafts(shared, PREFIX)).toEqual({
    comments: [draft('b', 'edited while sending'), draft('c')],
    note: 'overall, more',
  })
  withoutSent(readDrafts(shared, PREFIX))(shared, PREFIX)
  expect(shared.length).toBe(0)
})

it('clears the file it sent from when another file is opened while the send is delivered', async () => {
  const shared = storage()
  const other = draftsKey('/work/app/docs/notes.md')
  putComment(draft('same'))(shared, PREFIX)
  putComment(draft('same'))(shared, other)
  let delivered = (_to: number) => {}
  const sending = sendDrafts(
    shared,
    PREFIX,
    () => new Promise<number>((resolve) => (delivered = resolve)),
  )
  putNote('written on the other file meanwhile')(shared, other)
  delivered(80)
  expect(await sending).toEqual({ to: 80, cleared: true })
  expect(readDrafts(shared, PREFIX)).toEqual({ comments: [], note: '' })
  expect(readDrafts(shared, other)).toEqual({
    comments: [draft('same')],
    note: 'written on the other file meanwhile',
  })
})

it("says why Send cannot go: no comment yet, or over Review's limits", () => {
  expect(sendProblem({ comments: [draft('a')], note: 'n'.repeat(limits.text) })).toBeUndefined()
  expect(sendProblem({ comments: [], note: 'a note alone' })).toBe('Add a comment to send')
  expect(sendProblem({ comments: [draft('a')], note: 'n'.repeat(limits.text + 1) })).toMatch(
    /4,001 characters.*shorten it/,
  )
  expect(sendProblem({ comments: [draft('a', 'x'.repeat(limits.text + 1))], note: '' })).toMatch(
    /A comment is over 4,000/,
  )
  expect(
    sendProblem({ comments: Array.from({ length: 51 }, (_, i) => draft(`${i}`)), note: '' }),
  ).toMatch(/At most 50/)
})

it("caps an excerpt like Review's: 40 lines and 8 KB", () => {
  const many = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')
  expect(excerptOf(many).split('\n')).toHaveLength(limits.excerptLines)
  expect(new TextEncoder().encode(excerptOf('é'.repeat(10_000))).length).toBeLessThanOrEqual(
    limits.excerptBytes,
  )
})
