import type { EntryRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { switchAt } from '../../extensions/models/switches.ts'
import { responseAfter, turnOf } from '../../extensions/status-line/turns.ts'

let nextId = 1
const record = (kind: string, message: object) =>
  ({ id: nextId++, conversationId: 1, kind, model: [message] }) as unknown as EntryRecord

const display = (kind: string) =>
  ({ id: nextId++, conversationId: 1, kind, data: {} }) as unknown as EntryRecord

const input = (timestamp: number) => record('pi.user', { role: 'user', content: 'go', timestamp })

const response = ({
  model = 'opus',
  provider = 'anthropic',
  level = 'high',
  requested,
  prompt = 1000,
  cost = 0.1,
  timestamp = 0,
  durationMs = 0,
  stopReason = 'stop',
}: {
  model?: string
  provider?: string
  /** The thinking level the provider reports; null for none. */
  level?: string | null
  /** The thinking level the request asked for. */
  requested?: string
  prompt?: number
  cost?: number
  timestamp?: number
  durationMs?: number
  stopReason?: string
} = {}) =>
  record('pi.assistant', {
    role: 'assistant',
    provider,
    model,
    ...(level ? { providerThinkingLevel: level } : {}),
    ...(requested ? { thinkingLevel: requested } : {}),
    usage: { input: 0, cacheRead: prompt, cacheWrite: 0, output: 10, cost: { total: cost } },
    stopReason,
    timestamp,
    durationMs,
    content: [],
  })

describe('switchAt', () => {
  it('marks nothing for the first loaded response or an unchanged one', () => {
    const entries = [input(0), response(), response()]
    expect(switchAt(entries, entries[1])).toBeUndefined()
    expect(switchAt(entries, entries[2])).toBeUndefined()
  })

  it('names the provider only when it changed', () => {
    const entries = [
      response(),
      response({ model: 'sonnet' }),
      response({ provider: 'claude-code', model: 'sonnet' }),
    ]
    expect(switchAt(entries, entries[1])).toEqual({
      model: { from: 'opus', to: 'sonnet', fromRef: 'anthropic/opus', toRef: 'anthropic/sonnet' },
    })
    expect(switchAt(entries, entries[2])).toEqual({
      model: {
        from: 'anthropic/sonnet',
        to: 'claude-code/sonnet',
        fromRef: 'anthropic/sonnet',
        toRef: 'claude-code/sonnet',
      },
    })
  })

  it('compares thinking levels across a response that reports none', () => {
    const entries = [response(), response({ level: null }), response({ level: 'max' })]
    expect(switchAt(entries, entries[1])).toBeUndefined()
    expect(switchAt(entries, entries[2])).toEqual({ thinking: { from: 'high', to: 'max' } })
  })

  it('prefers the requested level, for providers that report none', () => {
    const openai = { provider: 'openai', model: 'gpt', level: null }
    const entries = [
      response({ ...openai, requested: 'high' }),
      response({ ...openai, requested: 'xhigh' }),
    ]
    expect(switchAt(entries, entries[1])).toEqual({ thinking: { from: 'high', to: 'xhigh' } })
  })

  it('compares responses from before requested levels were recorded by what the provider reported', () => {
    // Pi's xhigh is Anthropic's max: comparing across vocabularies would mark a switch that did not happen.
    const entries = [
      response({ level: 'max' }),
      response({ level: 'max', requested: 'xhigh' }),
      response({ level: 'high', requested: 'high' }),
    ]
    expect(switchAt(entries, entries[1])).toBeUndefined()
    expect(switchAt(entries, entries[2])).toEqual({ thinking: { from: 'xhigh', to: 'high' } })
  })

  it('reports a model and thinking change together', () => {
    const entries = [response({ provider: 'openai', model: 'gpt', level: null }), response()]
    expect(switchAt(entries, entries[1])).toEqual({
      model: {
        from: 'openai/gpt',
        to: 'anthropic/opus',
        fromRef: 'openai/gpt',
        toRef: 'anthropic/opus',
      },
    })
    const both = [response(), input(1), response({ model: 'sonnet', level: 'low' })]
    expect(switchAt(both, both[2])).toEqual({
      model: { from: 'opus', to: 'sonnet', fromRef: 'anthropic/opus', toRef: 'anthropic/sonnet' },
      thinking: { from: 'high', to: 'low' },
    })
  })
})

describe('turnOf', () => {
  it('adds up the responses since the input, across a compaction', () => {
    const entries = [
      response({ cost: 5 }),
      input(1000),
      response({ cost: 0.5, prompt: 100, stopReason: 'toolUse' }),
      record('pi.compaction', { role: 'user', content: 'summary', timestamp: 2000 }),
      response({ cost: 0.25, prompt: 50, timestamp: 3000, durationMs: 500 }),
    ]
    expect(turnOf(entries, entries[4])).toEqual({
      responses: 2,
      prompt: 150,
      output: 20,
      cost: 0.75,
      started: 1000,
    })
  })

  it('knows no turn whose input is not loaded', () => {
    const entries = [response(), response()]
    expect(turnOf(entries, entries[1])).toBeUndefined()
  })
})

describe('responseAfter', () => {
  it('finds the response an input was sent with, unless the context changed first', () => {
    const answered = [input(0), display('conversations.title-changed'), response({ prompt: 42 })]
    expect(responseAfter(answered, answered[0])?.usage.cacheRead).toBe(42)
    const condensed = [
      input(0),
      record('pi.compaction', { role: 'user', content: 'summary', timestamp: 1 }),
      response(),
    ]
    expect(responseAfter(condensed, condensed[0])).toBeUndefined()
  })
})
