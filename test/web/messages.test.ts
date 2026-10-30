import type { EntryRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { accentIndex, accentOf } from '../../extensions/messages/accent.tsx'
import { callerOf } from '../../extensions/messages/caller.ts'
import {
  answerTo,
  answeredMessages,
  callFailed,
  backgroundRow,
  conversationState,
  counterparts,
  stateWord,
  messageStatus,
  nextWaiting,
  openMessages,
  outgoingState,
  scriptMessaged,
  sentBy,
  sentStatus,
  threadRow,
  ultimateCompact,
  waitingOnUser,
} from '../../extensions/messages/data.tsx'
import type { Message } from '../../extensions/messages/refs.ts'

const response = (id: number, calls: string[]) =>
  ({
    id,
    conversationId: 7,
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        content: calls.map((call) => ({ type: 'toolCall', id: call, name: 'message' })),
      },
    ],
  }) as unknown as EntryRecord

describe('callerOf', () => {
  const entries = [response(1, ['a']), response(2, ['b', 'c'])]
  it('finds the response whose tool call sent a message, so go back returns there', () => {
    expect(callerOf(entries, 'c')?.id).toBe(2)
    expect(callerOf(entries, 'a')?.id).toBe(1)
  })
  it('finds nothing for a call outside the loaded entries', () => {
    expect(callerOf(entries, 'z')).toBeUndefined()
  })
})

describe('messages answer labels', () => {
  const request = {
    id: 1,
    from: 'user' as const,
    to: 2,
    text: 'Question',
    at: 0,
    reply: true,
    state: 'answered' as const,
    answer: 10,
  }
  it('selects a reply-enabled request for the answering entry', () => {
    expect(answeredMessages([request], 2, 10)).toEqual([request])
  })
  it('includes one-way deliveries without requiring the answered state', () => {
    const oneWay = { ...request, from: 4, reply: false, state: 'delivered' as const }
    expect(answeredMessages([oneWay], 2, 10)).toEqual([oneWay])
  })
  it('ignores other answers, conversations and requests with no answer', () => {
    expect(
      answeredMessages(
        [
          { ...request, answer: 11 },
          { ...request, to: 3 },
          { ...request, answer: undefined },
        ],
        2,
        10,
      ),
    ).toEqual([])
  })
  it('keeps every matching request in log order, excluding outgoing replies', () => {
    const second = { ...request, id: 2, from: 4, reply: false }
    expect(answeredMessages([request, second, { ...request, id: 3, to: 'user' }], 2, 10)).toEqual([
      request,
      second,
    ])
  })
})

describe('compact messages', () => {
  const base = { text: '', at: 0, reply: true, state: 'delivered' as const }
  // #2 is @ultimate, #4 a branch it started.
  const messages: Message[] = [
    { ...base, id: 1, from: 2, to: 'user' }, // @ultimate asks the user
    { ...base, id: 2, from: 'user', to: 2 }, // the user asks @ultimate
    { ...base, id: 3, from: 2, to: 4 }, // @ultimate asks the branch
    { ...base, id: 4, from: 2, to: 4, state: 'answered' },
    { ...base, id: 5, from: 4, to: 2, reply: false, re: 4 }, // the branch's answer
    { ...base, id: 6, from: 2, to: 'user', reply: false }, // one-way update
    { ...base, id: 7, from: 'user', to: 4, state: 'sent' },
    { ...base, id: 8, from: 2, to: 4, state: 'failed' },
  ]
  it('says who waits: open questions to the user apart from other open requests', () => {
    expect(messages.map(messageStatus)).toEqual([
      'yours',
      'waiting',
      'waiting',
      'answered',
      'reply',
      'one-way',
      'waiting',
      'failed',
    ])
    expect(messageStatus({ ...messages[5], state: 'sent' })).toBe('sending')
  })
  it('counts only open reply-enabled questions to the user', () => {
    // #1 is open; the one-way update, the answered and sending ones and those to others do not wait on the user.
    expect(
      waitingOnUser({
        messages: [
          ...messages,
          { ...base, id: 9, from: 2, to: 'user', state: 'answered' },
          { ...base, id: 10, from: 2, to: 'user', state: 'sent' },
          { ...base, id: 11, from: 2, to: 'user', state: 'dismissed' },
        ],
        next: 12,
      }),
    ).toBe(1)
    expect(waitingOnUser({ messages: [], next: 1 })).toBe(0)
  })
})

describe('sender accents', () => {
  it('gives each sender a stable palette slot', () => {
    expect(accentIndex(2, 6)).toBe(accentIndex(2, 6))
    expect(new Set([2, 3, 4, 5, 6, 7].map((id) => accentIndex(id, 6))).size).toBe(6)
  })
  it('gives the user the brand colour and conversations a palette colour, the same one every time', () => {
    expect(accentOf('user')).toEqual({
      fill: 'bg-brand/5',
      edge: 'border-brand/20',
      name: 'text-brand',
    })
    expect(accentOf(97078)).toBe(accentOf(97078))
    const conversations = [2, 3, 4, 5, 6, 7].map(accentOf)
    expect(new Set(conversations).size).toBe(6)
    expect(conversations.map((accent) => accent.name)).not.toContain('text-brand')
  })
  it('gives @ultimate a fixed purple apart from the palette and the remote violet', () => {
    const ultimate = accentOf('ultimate')
    expect(ultimate.name).toBe('text-purple-700 dark:text-purple-300')
    expect([2, 3, 4, 5, 6, 7].map(accentOf)).not.toContain(ultimate)
    expect(accentOf('remote')).not.toBe(ultimate)
  })
})

describe('@ultimate compact mode', () => {
  const standing = { ultimate: 7, lander: 8 }
  it("is @ultimate's conversation by the standing agents' index, whatever its title or label", () => {
    expect(ultimateCompact({ id: 7 }, standing)).toBe(true)
    // A rename or relabel changes nothing: the summary's title and label are not read.
    expect(
      ultimateCompact({ id: 7, title: 'Renamed', label: 'x' } as { id: number }, standing),
    ).toBe(true)
  })
  it('excludes other standing agents and conversations titled @ultimate, and waits for the index', () => {
    expect(ultimateCompact({ id: 8 }, standing)).toBe(false)
    expect(
      ultimateCompact({ id: 9, title: '@ultimate', label: 'agent' } as { id: number }, standing),
    ).toBe(false)
    expect(ultimateCompact({ id: 7 }, undefined)).toBe(false)
  })
})

/** A compact row of @ultimate (#7): an entry of `kind` with its data, model message and shown calls. */
const row = (kind: string, data?: object, model?: object, calls: object[] = []) => ({
  entry: {
    id: 30,
    conversationId: 7,
    kind,
    ...(data ? { data } : {}),
    ...(model ? { model: [model] } : {}),
  } as unknown as EntryRecord,
  calls: calls as { id: string; name: string; arguments: unknown }[],
})
const result = (toolCallId: string, isError: boolean) =>
  ({ model: [{ role: 'toolResult', toolCallId, isError }] }) as unknown as EntryRecord
const said = (stopReason: string) => ({ role: 'assistant', stopReason, content: [] })

describe("background in @ultimate's compact transcript", () => {
  const base = { text: 'Ship it?', at: 100, state: 'answered' as const }
  const log: Message[] = [
    { ...base, id: 1, from: 4, to: 7, reply: true, answer: 30 },
    { ...base, id: 2, from: 7, to: 'user', reply: true, call: 'ask' },
    { ...base, id: 3, from: 'user', to: 7, reply: false, re: 2 },
    { ...base, id: 4, from: 7, to: 5, reply: true, call: 'tell' },
  ]
  const messagesLog = { messages: log, next: 5 }

  it('is what agents say to each other, never what you and @ultimate say', () => {
    expect(backgroundRow(row('board.message', { from: 4 }), messagesLog)).toBe(true)
    expect(backgroundRow(row('board.reply', { from: 'remote' }), messagesLog)).toBe(true)
    expect(backgroundRow(row('board.message', { from: 'user' }), messagesLog)).toBe(false)
    expect(backgroundRow(row('lineage.note', { from: 4 }), messagesLog)).toBe(true)
    expect(backgroundRow(row('pi.user'), messagesLog)).toBe(false)
    expect(backgroundRow(row('some.new-kind'), messagesLog)).toBe(false)
    expect(backgroundRow(row('board.wake'), messagesLog)).toBe('hidden')
  })

  it('keeps landings in the compact transcript, and a report of a failed landing in the background', () => {
    expect(backgroundRow(row('lineage.note', { from: 4, source: 'lander' }), messagesLog)).toBe(
      false,
    )
    expect(
      backgroundRow(
        row('workspaces.lander-report', { outcome: { outcome: 'landed' } }),
        messagesLog,
      ),
    ).toBe(false)
    expect(
      backgroundRow(
        row('workspaces.lander-report', { outcome: { outcome: 'failed' } }),
        messagesLog,
      ),
    ).toBe(true)
    expect(backgroundRow(row('lineage.note', { from: 4, source: 'main' }), messagesLog)).toBe(true)
  })

  it('takes in branches and messages to agents, but not a message to you or an answer to you', () => {
    const branch = { id: 'b', name: 'branch', arguments: {} }
    const toAgent = { id: 'tell', name: 'message', arguments: { to: '#5' } }
    const toUser = { id: 'ask', name: 'message', arguments: { to: 'user' } }
    expect(
      backgroundRow(
        row('pi.assistant', undefined, said('toolUse'), [branch, toAgent]),
        messagesLog,
      ),
    ).toBe(true)
    expect(
      backgroundRow(
        row('pi.assistant', undefined, said('toolUse'), [toAgent, toUser]),
        messagesLog,
      ),
    ).toBe(false)
    // The answer went back to #4, which asked.
    expect(backgroundRow(row('pi.assistant', undefined, said('stop')), messagesLog)).toBe(true)
    expect(
      backgroundRow(row('pi.assistant', undefined, said('stop')), { messages: [], next: 1 }),
    ).toBe(false)
  })

  it('reads as the thread only what you and @ultimate say to each other', () => {
    const toUser = { id: 'ask', name: 'message', arguments: { to: 'user' } }
    const toAgent = { id: 'tell', name: 'message', arguments: { to: '#5' } }
    const empty = { messages: [], next: 1 }
    expect(threadRow(row('pi.user'), messagesLog)).toBe(true)
    expect(threadRow(row('board.message', { from: 'user' }), messagesLog)).toBe(true)
    expect(threadRow(row('pi.assistant', undefined, said('toolUse'), [toUser]), messagesLog)).toBe(
      true,
    )
    expect(threadRow(row('pi.assistant', undefined, said('stop')), empty)).toBe(true)
    // An answer that went back to the agent that asked, a message to an agent, a landing, a reload.
    expect(threadRow(row('pi.assistant', undefined, said('stop')), messagesLog)).toBe(false)
    expect(threadRow(row('pi.assistant', undefined, said('toolUse'), [toAgent]), messagesLog)).toBe(
      false,
    )
    expect(threadRow(row('lineage.note', { source: 'lander' }), messagesLog)).toBe(false)
    expect(threadRow(row('prompt.build'), messagesLog)).toBe(false)
  })

  it('names who each row was with', () => {
    const toAgent = { id: 'tell', name: 'message', arguments: { to: '#5' } }
    expect(counterparts(row('board.reply', { from: 4 }), messagesLog)).toEqual([4])
    expect(counterparts(row('lineage.note', { source: 'lander' }), messagesLog)).toEqual(['lander'])
    expect(counterparts(row('workspaces.lander-report'), messagesLog)).toEqual(['lander'])
    expect(
      counterparts(row('pi.assistant', undefined, said('toolUse'), [toAgent]), messagesLog),
    ).toEqual([5])
    expect(counterparts(row('pi.assistant', undefined, said('stop')), messagesLog)).toEqual([4])
  })

  it('tells a failed call from one that ran by its stored result', () => {
    const entries = [result('branch-1', true), result('branch-2', false)]
    expect(callFailed(entries, 'branch-1')).toBe(true)
    expect(callFailed(entries, 'branch-2')).toBe(false)
    // Still running: no result yet.
    expect(callFailed(entries, 'branch-3')).toBe(false)
  })

  it('pairs a question with your answer', () => {
    expect(answerTo(log, log[1])?.id).toBe(3)
    expect(answerTo(log, log[3])).toBeUndefined()
  })
})

const script = (id: string) => ({ id, name: 'codemode' })
describe('messages a codemode script sent', () => {
  const base = { from: 2, to: 'user' as const, text: 'Ship it?', at: 100, reply: true }
  // Identical texts from two scripts and a direct call, in different states, plus a message to a branch and one from
  // before the log recorded calls.
  const log: Message[] = [
    { ...base, id: 1, state: 'answered', call: 'a/1' },
    { ...base, id: 2, state: 'delivered', call: 'b/1' },
    { ...base, id: 3, state: 'delivered', call: 'a/3', reply: false },
    { ...base, id: 4, state: 'delivered', call: 'a' },
    { ...base, id: 5, state: 'sent', to: 4, call: 'a/4' },
    { ...base, id: 6, state: 'delivered', call: 'ab/1' },
    { ...base, id: 7, state: 'delivered' },
  ]
  it('binds each identical text to the call that sent it, in the order sent', () => {
    expect(sentBy(log, 'a').map((m) => [m.id, messageStatus(m)])).toEqual([
      [1, 'answered'],
      [3, 'one-way'],
      [4, 'yours'],
    ])
    expect(sentBy(log, 'b').map((m) => [m.id, messageStatus(m)])).toEqual([[2, 'yours']])
    expect(sentBy(log, 'c')).toEqual([])
  })
  it('keeps a script visible from the log alone, with or without a result', () => {
    expect(scriptMessaged(script('b'), { messages: log, next: 8 })).toBe(true)
    expect(scriptMessaged(script('c'), { messages: log, next: 8 })).toBe(false)
    expect(scriptMessaged({ id: 'b', name: 'bash' }, { messages: log, next: 8 })).toBe(false)
    expect(scriptMessaged(script('b'), undefined)).toBe(false)
  })
})

describe('a sent message the log no longer holds', () => {
  const message: Message = {
    id: 1,
    from: 2,
    to: 'user',
    text: 'Ship it?',
    at: 0,
    reply: true,
    state: 'delivered',
  }
  it('reads as sending only while its call runs, then shows no state', () => {
    expect(sentStatus(undefined, true)).toBe('sending')
    expect(sentStatus(undefined, false)).toBeUndefined()
    expect(sentStatus(message, false)).toBe('yours')
    expect(outgoingState(undefined, true, true)).toBe('sending')
    expect(outgoingState(undefined, true, false)).toBeUndefined()
    expect(outgoingState(message, true, false)).toBe('awaiting your reply')
    expect(outgoingState({ ...message, reply: false }, true, false)).toBe('delivered')
  })
})

/** A log of reply-expected questions from conversation 2 to the user, each overridable. */
const messagesLog = (...messages: Partial<Message>[]) => ({
  messages: messages.map((message, index) => ({
    id: index + 1,
    from: 2,
    to: 'user' as const,
    text: 'Question',
    at: 0,
    reply: true,
    state: 'delivered' as const,
    ...message,
  })),
  next: messages.length + 1,
})

describe('conversation state', () => {
  const primary = { id: 2, kind: 'primary' as const }
  const toUser = messagesLog({ from: 2, to: 'user' })

  it('is paused, not working, while a pause parks its run', () => {
    expect(conversationState({ ...primary, busy: true, parked: true }, toUser)).toBe('paused')
    expect(
      conversationState({ ...primary, runState: 'working', parked: true }, messagesLog()),
    ).toBe('paused')
  })

  it('is working while it runs or has input queued, before anything else', () => {
    expect(conversationState({ ...primary, busy: true }, toUser)).toBe('working')
    expect(conversationState({ ...primary, runState: 'working' }, toUser)).toBe('working')
    expect(conversationState({ ...primary, runState: 'queued' }, messagesLog())).toBe('working')
  })

  it('waits only for the primary agent with an open question to the user', () => {
    expect(conversationState({ ...primary, runState: 'answered' }, toUser)).toBe('waits')
    expect(conversationState({ ...primary, runState: 'answered' }, messagesLog())).toBe('idle')
    expect(
      conversationState({ ...primary, runState: 'answered' }, messagesLog({ state: 'answered' })),
    ).toBe('idle')
  })

  it('never waits for a subagent or another conversation, even with open messages to the user', () => {
    for (const kind of ['subagent', 'other'] as const)
      expect(conversationState({ id: 2, kind, runState: 'answered' }, toUser)).not.toBe('waits')
  })

  it('awaits the primary agent while its reply-expected message to it is open', () => {
    const branch = { id: 5, kind: 'other' as const, runState: 'answered' as const, primary: 3 }
    for (const state of ['sent', 'delivered'] as const)
      expect(conversationState(branch, messagesLog({ from: 5, to: 3, state }))).toBe('awaiting')
    expect(conversationState(branch, messagesLog({ from: 5, to: 3, state: 'answered' }))).toBe(
      'idle',
    )
    expect(conversationState(branch, messagesLog({ from: 5, to: 3, reply: false }))).toBe('idle')
    // A coordinator's question to its own worker waits on no one the user watches.
    expect(conversationState(branch, messagesLog({ from: 5, to: 9 }))).toBe('idle')
    // A subagent's question goes to its parent, which answers it in its own run: it never shows as awaiting.
    expect(
      conversationState({ ...branch, kind: 'subagent' }, messagesLog({ from: 5, to: 3 })),
    ).toBe('done')
  })

  it('awaits the primary agent after reporting to it, until the primary agent messages it', () => {
    const branch = { id: 5, kind: 'other' as const, runState: 'answered' as const, primary: 3 }
    const report = { from: 5, to: 3, reply: false, report: true as const }
    expect(conversationState(branch, messagesLog(report))).toBe('awaiting')
    // A note (no report) waits on nothing.
    expect(conversationState(branch, messagesLog({ from: 5, to: 3, reply: false }))).toBe('idle')
    expect(conversationState(branch, messagesLog(report, { from: 3, to: 5, reply: false }))).toBe(
      'idle',
    )
  })

  it('owes no report from a conversation concluded after it, until a newer report', () => {
    // The bug: two landed branches, concluded by @ultimate, still showed as owed on its composer chip.
    const report = { from: 5, to: 3, reply: false, report: true as const, at: 100 }
    const owed = (since: number | undefined, ...more: Partial<Message>[]) =>
      openMessages(messagesLog(report, ...more).messages, 3, (id) =>
        id === 5 ? since : undefined,
      ).owed.map((m) => m.id)
    expect(owed(undefined)).toEqual([1])
    expect(owed(Infinity)).toEqual([])
    // Concluded at 200, then resumed: its earlier report stays settled, a newer one is owed.
    expect(owed(200)).toEqual([])
    expect(owed(200, { ...report, at: 300 })).toEqual([2])
    const branch = { id: 5, kind: 'other' as const, runState: 'answered' as const, primary: 3 }
    expect(conversationState({ ...branch, concludedSince: 200 }, messagesLog(report))).toBe('idle')
  })

  it('says every state in a word, so a standing row or lane never falls back to idle', () => {
    // A standing agent (not the primary) asking @ultimate shows it, rather than idle.
    const standing = { id: 7, kind: 'other' as const, runState: 'answered' as const, primary: 3 }
    expect(stateWord(conversationState(standing, messagesLog({ from: 7, to: 3 })))).toBe(
      'awaiting @ultimate',
    )
    expect(stateWord('waits', 2)).toBe('2 waiting on you')
    expect(stateWord('failed')).toBe('failed')
    expect(stateWord('done')).toBe('done')
    expect(stateWord('idle')).toBe('idle')
  })

  it('cycles the open questions by id, oldest first, skipping closed ones and wrapping', () => {
    const log = messagesLog({}, { state: 'answered' }, { reply: false }, {}, { to: 4 }, {})
    expect(nextWaiting(log)?.id).toBe(1)
    expect(nextWaiting(log, 1)?.id).toBe(4)
    expect(nextWaiting(log, 4)?.id).toBe(6)
    expect(nextWaiting(log, 6)?.id).toBe(1)
    // The one last shown was answered meanwhile: the next after it, by id.
    log.messages[3].state = 'dismissed'
    expect(nextWaiting(log, 4)?.id).toBe(6)
    expect(nextWaiting(messagesLog({ state: 'answered' }))).toBeUndefined()
    // A single open question: every click shows it again.
    const one = messagesLog({ state: 'answered' }, {})
    expect(nextWaiting(one)?.id).toBe(2)
    expect(nextWaiting(one, 2)?.id).toBe(2)
  })

  it('failed when its latest input ended without an answer', () => {
    expect(conversationState({ id: 5, kind: 'other', runState: 'error' }, messagesLog())).toBe(
      'failed',
    )
  })

  it('done for an answered subagent, idle for any other answered conversation', () => {
    expect(
      conversationState({ id: 5, kind: 'subagent', runState: 'answered' }, messagesLog()),
    ).toBe('done')
    expect(conversationState({ id: 5, kind: 'other', runState: 'answered' }, messagesLog())).toBe(
      'idle',
    )
  })
})
