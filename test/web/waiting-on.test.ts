import { describe, expect, it } from 'vitest'
import type { Message } from '../../extensions/messages/refs.ts'
import {
  askedOn,
  busySubagents,
  deriveBlocker,
  type BlockerState,
} from '../../extensions/sidebar/waiting-on.ts'

const message = (fields: Partial<Message> & Pick<Message, 'id' | 'from'>): Message => ({
  to: 'user',
  text: 'Hello',
  at: 1,
  reply: true,
  state: 'delivered',
  ...fields,
})

describe('askedOn', () => {
  const log = {
    messages: [
      message({ id: 4, from: 7, state: 'answered' }),
      message({ id: 3, from: 7 }),
      message({ id: 2, from: 7, reply: false }),
      message({ id: 1, from: 9 }),
      message({ id: 0, from: 7, to: 1 }),
    ],
    next: 5,
  }

  it('keeps only a conversation’s open questions to the user, newest first', () => {
    expect(askedOn(log.messages, 7).map((asked) => asked.id)).toEqual([3])
  })

  it('keeps none for a conversation that asked nothing', () => {
    expect(askedOn(log.messages, 5)).toEqual([])
  })
})

describe('busySubagents', () => {
  const root = { id: 1, busy: false }
  const reader = { id: 2, parentConversationId: 1, ownerTaskId: 11, busy: false, title: 'Reader' }
  const fixer = {
    id: 3,
    parentConversationId: 2,
    ownerTaskId: 12,
    busy: true,
    title: 'Fixer',
    inputAt: 30,
  }
  const writer = {
    id: 4,
    parentConversationId: 1,
    ownerTaskId: 13,
    busy: true,
    title: 'Writer',
    inputAt: 20,
  }
  const branch = { id: 5, parentConversationId: 1, busy: true, title: 'A branch, not a subagent' }
  const done = { id: 6, parentConversationId: 1, ownerTaskId: 14, busy: false, title: 'Done' }

  it('finds the busy owned descendants, newest input first', () => {
    expect(
      busySubagents([root, reader, fixer, writer, branch, done], 1).map((subagent) => subagent.id),
    ).toEqual([3, 4])
  })

  it('finds none for a leaf, or when only idle subagents remain', () => {
    expect(busySubagents([root, reader, fixer, writer, branch, done], 3)).toEqual([])
    expect(busySubagents([root, reader, done], 1)).toEqual([])
  })
})

describe('deriveBlocker', () => {
  it('names an open question, normalising its text', () => {
    expect(
      deriveBlocker({
        asked: [{ questions: [{ text: '  Which\nmodel should I use?  ', kind: 'choice' }] }],
      }),
    ).toEqual({
      kind: 'question',
      label: 'Which model should I use?',
      detail: 'Which model should I use?',
    })
  })

  it('falls back to the answer itself for a plain reply-expected message', () => {
    expect(deriveBlocker({ asked: [{}] })).toEqual({ kind: 'question', label: 'your answer' })
  })

  it('names the check a landing is running', () => {
    expect(
      deriveBlocker({
        submission: {
          state: 'landing',
          steps: [
            { step: 'started', at: 1 },
            { step: 'checking: pnpm check', at: 2 },
          ],
        },
      }),
    ).toEqual({ kind: 'checks', label: 'pnpm check', detail: 'pnpm check' })
    expect(
      deriveBlocker({
        submission: {
          state: 'landing',
          steps: [
            { step: 'checking: pnpm check', at: 1 },
            {
              step: 'checked: pnpm check',
              at: 2,
              check: { command: 'pnpm check', result: 'failed' },
            },
            { step: 'rerunning: pnpm check', at: 3 },
          ],
        },
      }),
    ).toEqual({ kind: 'checks', label: 'pnpm check', detail: 'pnpm check' })
  })

  it('reads a finished landing as its current step', () => {
    expect(
      deriveBlocker({
        submission: {
          state: 'landing',
          steps: [
            { step: 'checking: pnpm check', at: 1 },
            {
              step: 'checked: pnpm check',
              at: 2,
              check: { command: 'pnpm check', result: 'passed' },
            },
            { step: 'fast-forwarding', at: 3 },
          ],
        },
      }),
    ).toEqual({ kind: 'submission', label: 'fast-forwarding', detail: 'fast-forwarding' })
  })

  it('names a submission still waiting for the lander', () => {
    expect(deriveBlocker({ submission: { state: 'queued', steps: [] } })).toEqual({
      kind: 'submission',
      label: 'waiting for the lander',
    })
  })

  it('names the newest subagent and counts the rest on hover', () => {
    const subagents = [
      { id: 3, busy: true, title: 'Fixer', inputAt: 30 },
      { id: 4, busy: true, title: 'Writer', inputAt: 20 },
    ]
    expect(deriveBlocker({ subagents })).toEqual({
      kind: 'subagent',
      label: 'subagent: Fixer',
      detail: '2 subagents: Fixer, Writer',
    })
    expect(deriveBlocker({ subagents: [{ id: 5, busy: true }] })).toEqual({
      kind: 'subagent',
      label: 'subagent: #5',
      detail: '#5',
    })
  })

  it('names queued input, and nothing else while the run works', () => {
    expect(deriveBlocker({ runState: 'queued' })).toEqual({ kind: 'input', label: 'input queued' })
    expect(deriveBlocker({ runState: 'working' })).toEqual({ kind: 'none', label: '' })
  })

  it('shows nothing for a conversation waiting on nothing', () => {
    expect(deriveBlocker({})).toEqual({ kind: 'none', label: '' })
    expect(deriveBlocker({ runState: 'answered' })).toEqual({ kind: 'none', label: '' })
  })

  it('answers a question before the landing, the landing before its subagents, subagents before queued input', () => {
    const question: BlockerState = {
      asked: [{ questions: [{ text: 'Which model?', kind: 'choice' }] }],
    }
    const landing: BlockerState = {
      submission: { state: 'landing', steps: [{ step: 'checking: pnpm check', at: 1 }] },
    }
    const subagents: BlockerState = { subagents: [{ id: 3, busy: true, title: 'Fixer' }] }
    const input: BlockerState = { runState: 'queued' }
    expect(deriveBlocker({ ...question, ...landing, ...subagents, ...input }).kind).toBe('question')
    expect(deriveBlocker({ ...landing, ...subagents, ...input }).kind).toBe('checks')
    expect(deriveBlocker({ ...subagents, ...input }).kind).toBe('subagent')
    expect(deriveBlocker({ ...input }).kind).toBe('input')
    expect(deriveBlocker({}).kind).toBe('none')
  })
})
