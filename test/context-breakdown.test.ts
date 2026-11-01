import type { EntryRecord } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { setAsideIds } from '../web/src/app/compact.ts'
import {
  breakdownAt,
  diffAt,
  modelLine,
  opensContext,
  ownStart,
  promptAt,
} from '../extensions/context/breakdown.ts'

let next = 1
// Fixtures write messages loosely; the module reads only the fields they set.
const entry = (kind: string, fields: { model?: unknown[]; data?: unknown } = {}) =>
  ({ id: next++, conversationId: 7, kind, createdAt: 0, ...fields }) as unknown as EntryRecord
const system = (
  sections?: Record<string, string | null>,
  toolsAdded?: { name: string; description: string; parameters: unknown }[],
  toolsRemoved?: { name: string }[],
) =>
  entry('pi.system', {
    model: [
      {
        role: 'system',
        content: '',
        timestamp: 0,
        ...(sections && { sections }),
        ...(toolsAdded && { toolsAdded }),
        ...(toolsRemoved && { toolsRemoved }),
      },
    ],
  })
const user = (text: string) =>
  entry('pi.user', {
    model: [{ role: 'user', content: text, timestamp: 0 }],
  })
/** An entry of the fork's source, #1. */
const source = (fields: object) => ({ ...fields, conversationId: 1 }) as unknown as EntryRecord
const read = { name: 'read', description: 'Read a file', parameters: { type: 'object' } }
const bash = { name: 'bash', description: 'Run a command', parameters: { type: 'object' } }

it('breaks a baseline down into sections, tools and their token estimates, with the first response model', () => {
  const entries = [
    user('hello'),
    system({ identity: 'x'.repeat(35), rules: 'y'.repeat(70) }, [read, bash]),
    entry('pi.assistant', {
      model: [
        {
          role: 'assistant',
          content: [],
          provider: 'anthropic',
          model: 'claude',
          thinkingLevel: 'high',
          timestamp: 0,
        },
      ],
    }),
  ]
  const breakdown = breakdownAt(entries, 0)
  expect(breakdown.start).toBeUndefined()
  expect(breakdown.system).toBe(entries[1])
  expect(breakdown.prompt?.sections).toEqual([
    { key: 'identity', text: 'x'.repeat(35), tokens: 10 },
    { key: 'rules', text: 'y'.repeat(70), tokens: 20 },
  ])
  const readTokens = Math.ceil(JSON.stringify(read).length / 3.5)
  expect(breakdown.prompt?.tools.map((tool) => [tool.name, tool.tokens])).toEqual([
    ['read', readTokens],
    ['bash', Math.ceil(JSON.stringify(bash).length / 3.5)],
  ])
  expect(breakdown.model).toEqual({ provider: 'anthropic', model: 'claude', thinking: 'high' })
  expect(breakdown.tokens.prompt).toBe(30)
  expect(breakdown.tokens.total).toBe(breakdown.tokens.prompt + breakdown.tokens.tools)
})

it('replays patches in order: a value replaces in place, null removes, a re-added section goes last', () => {
  const entries = [
    system({ a: 'one', b: 'two', c: 'three' }),
    system({ b: 'TWO', a: null }),
    system({ a: 'again' }),
  ]
  expect(promptAt(entries, 1).sections.map((section) => [section.key, section.text])).toEqual([
    ['b', 'TWO'],
    ['c', 'three'],
  ])
  expect(promptAt(entries, 2).sections.map((section) => section.key)).toEqual(['b', 'c', 'a'])
})

it('starts the replay again at a reset and reads the brief it injects as the context start', () => {
  const brief = entry('pi.reset', {
    data: { lineage: { brief: { tally: 3 } } },
    model: [{ role: 'user', content: 'm'.repeat(350), timestamp: 0 }],
  })
  const entries = [system({ old: 'gone' }, [read]), brief, user('go'), system({ fresh: 'new' })]
  const breakdown = breakdownAt(entries, 1)
  expect(breakdown.injected).toMatchObject({ label: 'memory brief', tokens: 100 })
  expect(breakdown.prompt?.sections.map((section) => section.key)).toEqual(['fresh'])
  expect(breakdown.prompt?.tools).toEqual([])
  expect(breakdown.tokens.total).toBe(100 + breakdown.tokens.prompt)
  expect(opensContext(entries, 3, 1)).toBe(true)
  expect(opensContext(entries, 0, 0)).toBe(true)
})

it('counts an image as a fixed size, never its base64 length', () => {
  const reset = entry('pi.reset', {
    model: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see' },
          { type: 'image', data: 'A'.repeat(500_000), mimeType: 'image/png' },
        ],
        timestamp: 0,
      },
    ],
  })
  expect(breakdownAt([reset], 0).injected?.tokens).toBe(Math.ceil((3 + 4800) / 3.5))
})

it('diffs a patch against the state before it, with token deltas for sections and tools', () => {
  const entries = [
    system({ keep: 'same', grow: 'abc' }, [read, bash]),
    system({ grow: 'abcdefghij'.repeat(7), extra: 'e'.repeat(35), keep: null }, undefined, [bash]),
  ]
  const diff = diffAt(entries, 1)
  expect(diff.sections).toEqual([
    {
      key: 'grow',
      change: 'changed',
      text: 'abcdefghij'.repeat(7),
      before: 'abc',
      delta: 20 - 1,
    },
    { key: 'extra', change: 'added', text: 'e'.repeat(35), delta: 10 },
    { key: 'keep', change: 'removed', text: 'same', delta: -2 },
  ])
  expect(diff.tools.map((tool) => [tool.name, tool.change])).toEqual([['bash', 'removed']])
  expect(diff.delta).toBe(19 + 10 - 2 + diff.tools[0].delta)
})

it('treats a removed and re-added tool as unchanged unless its declaration changed', () => {
  const changedRead = { ...read, description: 'Read a file, with offsets' }
  const entries = [
    system({ a: 'x' }, [read, bash]),
    system(undefined, [read, bash], [{ name: 'read' }, { name: 'bash' }]),
    system(undefined, [changedRead], [{ name: 'read' }]),
  ]
  expect(diffAt(entries, 1).tools).toEqual([])
  expect(promptAt(entries, 1).tools.map((tool) => tool.name)).toEqual(['read', 'bash'])
  const diff = diffAt(entries, 2)
  expect(diff.tools.map((tool) => [tool.name, tool.change])).toEqual([['read', 'changed']])
  expect(promptAt(entries, 2).tools.map((tool) => tool.name)).toEqual(['bash', 'read'])
})

it('folds a remove-all patch into the re-add after it, so a reorder shows only real changes', () => {
  const entries = [
    system({ a: 'one', b: 'two' }),
    system({ a: null, b: null }),
    system({ b: 'two', a: 'ONE' }),
  ]
  expect(diffAt(entries, 2).sections.map((section) => [section.key, section.change])).toEqual([
    ['a', 'changed'],
  ])
})

it('takes a fork start’s snapshot after a remove-all and its reordered re-add', () => {
  const inheritedBaseline = { ...system({ a: 'one', b: 'two' }, [read]), conversationId: 1 }
  const own = user('go')
  const removeAll = system({ a: null, b: null })
  const reAdd = system({ b: 'two', a: 'one' })
  const entries = [inheritedBaseline, own, removeAll, reAdd] as unknown as EntryRecord[]
  const breakdown = breakdownAt(entries, 1)
  expect(breakdown.system).toBe(reAdd)
  expect(breakdown.prompt?.sections.map((section) => section.key)).toEqual(['b', 'a'])
  expect(breakdown.prompt?.tools.map((tool) => tool.name)).toEqual(['read'])
  expect(opensContext(entries, 3, 1)).toBe(true)
  expect(opensContext(entries, 2, 1)).toBe(false)
})

it('shows the recorded model, and the configured one marked as such only before any response', () => {
  const configured = { model: { provider: 'faux', modelId: 'faux-1' }, thinkingLevel: 'high' }
  expect(
    modelLine({ provider: 'anthropic', model: 'claude', thinking: 'low' }, configured),
  ).toEqual({
    text: 'anthropic/claude · low',
    configured: false,
  })
  expect(modelLine(undefined, configured)).toEqual({ text: 'faux/faux-1 · high', configured: true })
  expect(modelLine(undefined, {})).toBeUndefined()
})

it('carries a fork the entries its source’s compaction kept before the marker', () => {
  const dropped = source(user('dropped by the compaction'))
  const kept = source(user('k'.repeat(35)))
  const compaction = source(
    entry('pi.compaction', { model: [{ role: 'user', content: 's'.repeat(70), timestamp: 0 }] }),
  )
  const head = { ...compaction, head: kept.id } as EntryRecord
  const after = source(user('a'.repeat(35)))
  const own = user('mine')
  const breakdown = breakdownAt([dropped, kept, head, after, own], 4)
  expect(breakdown.injected?.label).toBe('inherited history · 3 messages')
  expect(breakdown.injected?.tokens).toBe(20 + 10 + 10)
  expect(breakdown.injected?.content).not.toContain('dropped')
})

it('carries only the newest summary after consecutive compactions', () => {
  const kept = source(user('k'.repeat(35)))
  const older = source(
    entry('pi.compaction', { model: [{ role: 'user', content: 'old summary', timestamp: 0 }] }),
  )
  const newer = {
    ...source(
      entry('pi.compaction', { model: [{ role: 'user', content: 's'.repeat(70), timestamp: 0 }] }),
    ),
    head: kept.id,
  } as EntryRecord
  const own = user('mine')
  const breakdown = breakdownAt([kept, older, newer, own], 3)
  expect(breakdown.injected?.label).toBe('inherited history · 2 messages')
  expect(breakdown.injected?.content).not.toContain('old summary')
})

it('replays without patches a go-back set aside: change, go back, change again shows a diff', () => {
  const baseline = system({ a: 'one' })
  const point = user('try it')
  const first = system({ a: 'two' })
  const back = entry('lineage.rewound', { data: { setAside: point.id } })
  const again = system({ a: 'two' })
  const entries = [baseline, point, first, back, again]
  const aside = setAsideIds(entries)
  expect(aside.has(first.id)).toBe(true)
  expect(diffAt(entries, 4).sections).toEqual([])
  expect(
    diffAt(entries, 4, aside).sections.map((section) => [section.key, section.change]),
  ).toEqual([['a', 'changed']])
})

it('finds where a fork’s own entries start', () => {
  const inherited = { ...user('root'), conversationId: 1 } as unknown as EntryRecord
  const own = user('mine')
  expect(ownStart([inherited, own], 7)).toBe(1)
})
