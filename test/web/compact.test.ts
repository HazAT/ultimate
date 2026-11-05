import type { EntryRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import {
  anchorSelector,
  compactRows,
  groupAside,
  groupBetween,
  isOpenIn,
  openIn,
  partsOf,
  runOf,
  setAsideIds,
} from '../../web/src/app/compact.ts'
import type { CompactPart, WorkRun } from '../../web/src/app/compact.ts'
import { threadRow } from '../../extensions/messages/data.tsx'

let nextId = 1
const entry = (kind: string, message?: object, data?: object) =>
  ({
    id: nextId++,
    conversationId: 1,
    kind,
    ...(message ? { model: [message] } : {}),
    ...(data ? { data } : {}),
  }) as unknown as EntryRecord
const user = (text: string) => entry('pi.user', { role: 'user', content: text })
const system = () => entry('pi.system', { role: 'system', sections: {} })
const thinking = (text = 'Considering') => ({ type: 'thinking', thinking: text })
const text = (value: string) => ({ type: 'text', text: value })
const call = (name: string) => ({ type: 'toolCall', id: `call-${nextId}-${name}`, name })
const assistant = (stopReason: string, ...content: object[]) =>
  entry('pi.assistant', { role: 'assistant', stopReason, content })
const result = () => entry('pi.tool-result', { role: 'toolResult', toolCallId: 'orphan' })
const names = new Set(['message', 'branch'])
const visible = (block: { name: string }) => names.has(block.name)

/** Rows as ids: `n` a whole entry, `n:a,b` its blocks, `[…] ×steps` a folded run. */
const shape = (rows: (CompactPart | WorkRun)[]) =>
  rows.map((row) => ('work' in row ? `[${row.work.map(part).join(' ')}] ×${row.steps}` : part(row)))
const part = (row: CompactPart) =>
  row.blocks ? `${row.entry.id}:${row.blocks.join(',')}` : String(row.entry.id)

describe('compact rows', () => {
  it('folds a run of tool calls between an input and its answer, and leaves the answer whole', () => {
    nextId = 1
    const rows = compactRows(
      [
        user('check the tests'),
        system(),
        assistant('toolUse', thinking(), call('bash')),
        assistant('toolUse', text('Reading it.'), call('read'), call('read')),
        assistant('stop', thinking(), text('All green.')),
      ],
      visible,
    )
    expect(shape(rows)).toEqual(['1', '[2 3 4] ×4', '5'])
  })

  it('keeps visible tool calls as rows that split a run, in their order', () => {
    nextId = 1
    const rows = compactRows(
      [
        assistant('toolUse', thinking(), call('message')),
        assistant('toolUse', call('bash'), call('branch'), call('note'), call('read')),
        assistant('toolUse', call('message')),
        assistant('stop', text('Started it.')),
      ],
      visible,
    )
    expect(shape(rows)).toEqual(['[1:0] ×1', '1:1', '[2:0] ×1', '2:1', '[2:2,3] ×2', '3', '4'])
  })

  it('ends a run at messages and other entries, which stay visible', () => {
    nextId = 1
    const rows = compactRows(
      [
        entry('board.message', undefined, { from: 4, text: 'Landed' }),
        assistant('toolUse', call('bash')),
        result(),
        entry('lineage.note', undefined, { text: 'note' }),
        assistant('toolUse', call('edit')),
        assistant('stop', text('Done.')),
      ],
      visible,
    )
    expect(shape(rows)).toEqual(['1', '[2 3] ×2', '4', '[5] ×1', '6'])
  })

  it('shows a run without steps as it is, and errors whole', () => {
    nextId = 1
    const rows = compactRows(
      [
        user('hello'),
        system(),
        assistant('toolUse', thinking(''), text('Let me look.')),
        assistant('error'),
      ],
      visible,
    )
    expect(shape(rows)).toEqual(['1', '2', '3', '4'])
  })

  it('folds the open run at the end of a working conversation', () => {
    nextId = 1
    const rows = compactRows([user('go'), assistant('toolUse', call('bash'))], visible)
    expect(shape(rows)).toEqual(['1', '[2] ×1'])
  })

  it('keeps the calls its test keeps, by more than their name', () => {
    nextId = 1
    const script = { ...call('codemode'), arguments: { sent: true } }
    const rows = compactRows(
      [assistant('toolUse', call('codemode'), script), assistant('stop', text('Asked.'))],
      (block) => block.name === 'codemode' && block.arguments?.sent === true,
    )
    expect(shape(rows)).toEqual(['[1:0] ×1', '1:1', '2'])
  })
})

describe('revealing a compact entry', () => {
  it('finds the folded run an entry first shows in, past its first entry and in split responses', () => {
    nextId = 1
    const rows = compactRows(
      [
        user('check'),
        assistant('toolUse', call('bash')),
        assistant('toolUse', call('read')),
        assistant('toolUse', call('message'), call('bash')),
        assistant('stop', text('Done.')),
      ],
      visible,
    )
    expect(shape(rows)).toEqual(['1', '[2 3] ×2', '4:0', '[4:1] ×1', '5'])
    expect(runOf(rows, 2)).toBe(rows[1])
    expect(runOf(rows, 3)).toBe(rows[1])
    // A split response first shows as its visible call, so revealing it opens nothing.
    expect(runOf(rows, 4)).toBeUndefined()
    expect(runOf(rows, 1)).toBeUndefined()
    expect(runOf(rows, 5)).toBeUndefined()
    expect(runOf(rows, 99)).toBeUndefined()
  })

  it('opens the run when a split response starts with folded work', () => {
    nextId = 1
    const rows = compactRows(
      [user('go'), assistant('toolUse', call('bash'), call('message'))],
      visible,
    )
    expect(shape(rows)).toEqual(['1', '[2:0] ×1', '2:1'])
    expect(runOf(rows, 2)).toBe(rows[1])
  })
})

describe('set-aside rows', () => {
  const back = (point: number) => entry('lineage.rewound', undefined, { setAside: point })
  it('sets aside what came after each go-back, and what a later go-back before it reaches', () => {
    nextId = 1
    // 1 2 3 | back to 1 (4) | 5 6 | back to 4 (7), the first note itself | 8
    const entries = [
      user('a'),
      user('b'),
      user('c'),
      back(1),
      user('d'),
      user('e'),
      back(4),
      user('f'),
    ]
    // Going back to the first note keeps what it set aside (2, 3) aside, and sets aside 5 and 6.
    expect([...setAsideIds(entries)].toSorted((a, b) => a - b)).toEqual([2, 3, 5, 6])
    // Back before the first go-back: its note leaves too.
    const again = [...entries, back(1)]
    expect([...setAsideIds(again)].toSorted((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8])
    expect(setAsideIds([user('x')]).size).toBe(0)
  })
  it('folds each stretch of set-aside rows into one group with its steps', () => {
    nextId = 1
    const entries = [user('a'), user('b'), system(), user('c'), back(1), user('d')]
    const grouped = groupAside(
      entries.map((value) => ({ entry: value })),
      setAsideIds(entries),
    )
    expect(
      grouped.map((row) =>
        'aside' in row
          ? `aside ${row.aside.length} ×${row.steps}`
          : String((row as CompactPart).entry.id),
      ),
    ).toEqual(['1', 'aside 3 ×2', '5', '6'])
  })
})

describe('folded groups', () => {
  it('keeps an open run open when a page of earlier history extends it', () => {
    nextId = 1
    const earlier = assistant('toolUse', call('read'))
    const later = [assistant('toolUse', call('bash')), user('next')]
    const before = compactRows(later, visible)[0] as WorkRun
    const opened = openIn(new Set(), before, true)
    const after = compactRows([earlier, ...later], visible)[0] as WorkRun
    // Its first part, and so the key a run was known by, changed.
    expect(partsOf(after)[0].entry).toBe(earlier)
    expect(isOpenIn(opened, after)).toBe(true)
    expect(isOpenIn(openIn(opened, after, false), after)).toBe(false)
  })

  it('finds a scroll anchor by its last entry, or a row inside an open run', () => {
    expect(anchorSelector({ entryId: 3, last: 5, inner: false })).toBe(
      ':scope > [data-run-last="5"]',
    )
    // A row inside an open run, never the run that may carry the same id.
    expect(anchorSelector({ entryId: 3, inner: true })).toBe(
      '[data-run-last] [data-entry-id="3"]:not([data-run-last])',
    )
    expect(anchorSelector({ entryId: 3, inner: false })).toBe('[data-entry-id="3"]')
  })

  it('folds everything between two thread rows into one stretch', () => {
    const ids = groupBetween(
      [1, 2, 3, 4, 5, 6].map((id) => ({ id })),
      ({ id }) => id === 2 || id === 5,
    )
    expect(ids.map((row) => ('between' in row ? row.between.map(({ id }) => id) : row.id))).toEqual(
      [[1], 2, [3, 4], 5, [6]],
    )
  })

  it("folds no stretch made only of rows that render nothing, such as the user's hidden answers", () => {
    // @ultimate's answer, the hidden note carrying the user's answers, then the user's next input: no empty line between.
    nextId = 1
    const rows = [
      assistant('stop', text('I can ask you directly.')),
      entry('board.answered'),
      user('next'),
    ].map((value) => ({ entry: value }))
    const thread = (row: CompactPart) => threadRow({ entry: row.entry, calls: [] }, undefined)
    expect(groupBetween(rows, thread).some((row) => 'between' in row)).toBe(false)
    // Nor of a system prompt change alone, which a stretch's line does not count either.
    const prompt = [rows[2], { entry: system() }, { entry: assistant('stop', text('pong')) }]
    expect(groupBetween(prompt, thread).some((row) => 'between' in row)).toBe(false)
    // With a row that shows, the stretch folds with the hidden one inside it.
    const shown = [rows[0], rows[1], { entry: entry('lineage.note') }, rows[2]]
    expect(groupBetween(shown, thread).filter((row) => 'between' in row)).toHaveLength(1)
  })
})
