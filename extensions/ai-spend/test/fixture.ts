/** A forked conversation's entries in the store's shapes, priced like Claude Opus ($5 / $25 / $0.50 / $6.25 per Mtok). */
import type { EntryLike } from '../model/rows.ts'

export const PRICE = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }
export const OWN = 10
export const PARENT = 5
const T0 = new Date(2026, 10, 16, 9).getTime()

type Call = { name: string; arguments: Record<string, unknown> }
export function assistant(
  id: number,
  conversationId: number,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
  at: number,
  options: { text?: string; thinking?: string; calls?: Call[]; fromProvider?: number } = {},
): EntryLike {
  const cost = {
    input: (usage.input * PRICE.input) / 1e6,
    output: (usage.output * PRICE.output) / 1e6,
    cacheRead: (usage.cacheRead * PRICE.cacheRead) / 1e6,
    cacheWrite: (usage.cacheWrite * PRICE.cacheWrite) / 1e6,
  }
  const total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite
  return {
    id,
    conversationId,
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        content: [
          ...(options.thinking ? [{ type: 'thinking', thinking: options.thinking }] : []),
          ...(options.text ? [{ type: 'text', text: options.text }] : []),
          ...(options.calls ?? []).map((call, i) => ({
            type: 'toolCall',
            id: `c${id}-${i}`,
            ...call,
          })),
        ],
        usage: {
          ...usage,
          totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
          cost: {
            ...cost,
            total: options.fromProvider ?? total,
            totalFromProvider: options.fromProvider !== undefined,
          },
        },
        timestamp: T0 + at,
        durationMs: 1000,
        thinkingLevel: 'high',
      },
    ],
  }
}
export const toolResult = (
  id: number,
  conversationId: number,
  toolName: string,
  chars: number,
  image = false,
): EntryLike => ({
  id,
  conversationId,
  kind: 'pi.tool-result',
  model: [
    {
      role: 'toolResult',
      toolName,
      content: [
        { type: 'text', text: 'x'.repeat(chars) },
        ...(image ? [{ type: 'image', data: '', mimeType: 'image/png' }] : []),
      ],
    },
  ],
})
export const userInput = (
  id: number,
  conversationId: number,
  chars: number,
  at: number,
): EntryLike => ({
  id,
  conversationId,
  kind: 'board.message',
  model: [{ role: 'user', content: 'u'.repeat(chars), timestamp: T0 + at }],
})

const MIN = 60_000
/**
 * #10 forked from #5 after entry 3: an inherited input, response and bash result, then its own input, a response with
 * two parallel calls, a response after their results, a compaction, an idle rewrite, and a quick rewrite.
 */
export const entries: EntryLike[] = [
  userInput(1, PARENT, 400, 0),
  assistant(2, PARENT, { input: 10, output: 100, cacheRead: 0, cacheWrite: 1000 }, MIN, {
    text: 'x',
    calls: [{ name: 'bash', arguments: { command: 'ls' } }],
  }),
  toolResult(3, PARENT, 'bash', 1000),
  userInput(11, OWN, 600, 2 * MIN),
  // prompt 2000: the jump over #2 is 2000 - 1010 - 100 = 890, split 1000 : 600 between the bash result and the input.
  assistant(12, OWN, { input: 10, output: 200, cacheRead: 1010, cacheWrite: 980 }, 3 * MIN, {
    text: 'a'.repeat(100),
    thinking: 't'.repeat(100),
    calls: [
      { name: 'bash', arguments: { command: 'b'.repeat(86) } },
      { name: 'read', arguments: { path: 'r'.repeat(189) } },
    ],
  }),
  toolResult(13, OWN, 'bash', 500),
  toolResult(14, OWN, 'read', 1500),
  // prompt 3000: the jump is 3000 - 2000 - 200 = 800, split 1 : 3.
  assistant(15, OWN, { input: 5, output: 50, cacheRead: 2000, cacheWrite: 995 }, 4 * MIN, {
    text: 'done',
  }),
  {
    id: 16,
    conversationId: OWN,
    kind: 'pi.compaction',
    model: [{ role: 'user', content: [{ type: 'text', text: 'summary' }] }],
  },
  // After the compaction, 10 min idle: the whole prompt is written again.
  assistant(17, OWN, { input: 5, output: 40, cacheRead: 0, cacheWrite: 800 }, 14 * MIN, {
    calls: [{ name: 'edit', arguments: { path: 'e' } }],
  }),
  toolResult(18, OWN, 'edit', 250, true),
  // A minute later, most of the prompt written again (another rewrite, not idle).
  assistant(19, OWN, { input: 5, output: 30, cacheRead: 100, cacheWrite: 900 }, 15 * MIN, {
    text: 'ok',
  }),
]
