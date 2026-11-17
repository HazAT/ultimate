import type { ConversationId, EntryId, EntryRecord, Tx } from '@earendil-works/pi-durable'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { actions } from '../server.ts'
import type { ActionContext } from '../../../server/actions.ts'
import type { Message } from '../../messages/api.ts'

const BRANCH = 10 as ConversationId
const DESIGNER = 11 as ConversationId

const png = (pixels: string) => ({ type: 'image' as const, mimeType: 'image/png', data: pixels })

function shot(
  conversation: ConversationId,
  id: number,
  at: number,
  call: string,
  args: Record<string, unknown>,
  pixels: string,
): EntryRecord[] {
  return [
    {
      id: (id + 1) as EntryId,
      conversationId: conversation,
      kind: 'pi.tool-result',
      model: [
        {
          role: 'toolResult',
          toolCallId: call,
          toolName: 'screenshot',
          content: [{ type: 'text', text: 'saved' }, png(pixels)],
          isError: false,
          timestamp: at + 1,
        },
      ],
    },
    {
      id: id as EntryId,
      conversationId: conversation,
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: call, name: 'screenshot', arguments: args }],
          timestamp: at,
        },
      ],
    } as unknown as EntryRecord,
  ]
}

function fixture() {
  const entries = new Map<ConversationId, EntryRecord[]>([
    [
      BRANCH,
      [
        ...shot(BRANCH, 50, 500, 'c4', { url: '/?conversation=2', width: 390 }, 'C'),
        ...shot(BRANCH, 30, 300, 'c2', { url: '/' }, 'A'),
        ...shot(BRANCH, 10, 100, 'c0', { url: '/' }, 'OLD'),
      ].toSorted((a, b) => b.id - a.id),
    ],
    [
      DESIGNER,
      [
        ...shot(DESIGNER, 42, 420, 'd2', { url: '/' }, 'B'),
        ...shot(DESIGNER, 40, 400, 'd1', { url: '/', theme: 'dark' }, 'B'),
      ].toSorted((a, b) => b.id - a.id),
    ],
  ])
  const message = (id: number, at: number): Message => ({
    id,
    from: BRANCH,
    to: 'user',
    text: '',
    at,
    reply: true,
    state: 'sent',
  })
  const tx = {
    doc: async () => ({ messages: [message(1, 200), message(2, 600)], next: 3 }),
    scanEntries: async ({ conversationId }: { conversationId: ConversationId }) => ({
      items: entries.get(conversationId) ?? [],
    }),
  } as unknown as Tx
  const host = {
    conversations: () => [
      { id: BRANCH, label: 'coordinator', busy: false },
      { id: DESIGNER, parentConversationId: BRANCH, label: 'designer', busy: false },
      { id: 99 as ConversationId, parentConversationId: ROOT_CONVERSATION_ID, busy: false },
    ],
    harness: () => ({ commit: (fn: (tx: Tx) => unknown) => fn(tx) }),
  }
  return { host, signal: new AbortController().signal } as unknown as ActionContext
}

it("plays a question's round across the branch and its subagents, collapsing identical frames", async () => {
  const reel = await actions.frames({ conversation: BRANCH, message: 2 }, fixture())
  expect(reel).toEqual({
    earlier: 0,
    frames: [
      { conversation: BRANCH, entry: 31, image: 1, agent: 'coordinator', step: '/', count: 1 },
      {
        conversation: DESIGNER,
        entry: 41,
        image: 1,
        agent: 'designer #11',
        step: '/ · dark',
        count: 2,
      },
      {
        conversation: BRANCH,
        entry: 51,
        image: 1,
        agent: 'coordinator',
        step: '/?conversation=2 · 390 px',
        count: 1,
      },
    ],
  })
})

it("a landing's reel spans the whole branch", async () => {
  const reel = await actions.frames({ conversation: BRANCH }, fixture())
  expect(reel.frames.map((frame) => frame.entry)).toEqual([11, 31, 41, 51])
})
