import type { ConversationId, EntryId, EntryRecord } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { actions } from '../server.ts'
import { imagesOf } from '../../../lib/entries.ts'
import type { ActionContext } from '../../../server/actions.ts'
import type { Message } from '../../messages/api.ts'

const BRANCH = 10 as ConversationId
const DESIGNER = 11 as ConversationId

const call = (
  conversation: ConversationId,
  id: number,
  callId: string,
  name: string,
  args: Record<string, unknown>,
) =>
  ({
    id: id as EntryId,
    conversationId: conversation,
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: callId, name, arguments: args }],
        timestamp: id,
      },
    ],
  }) as unknown as EntryRecord

function shot(
  conversation: ConversationId,
  id: number,
  callId: string,
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
          toolCallId: callId,
          toolName: 'browser',
          content: [
            { type: 'text', text: 'note' },
            { type: 'image', mimeType: 'image/png', data: pixels },
            { type: 'text', text: 'Title' },
          ],
          isError: false,
          timestamp: id + 1,
        },
      ],
    },
    call(conversation, id, callId, 'browser', args),
  ]
}

const asks = (id: number, callId: string) =>
  call(BRANCH, id, callId, 'message', { to: 'user', reply: true, text: 'Preview?' })

function fixture() {
  const own = new Map<ConversationId, EntryRecord[]>([
    [
      BRANCH,
      [
        asks(60, 'ask2'),
        ...shot(BRANCH, 50, 'c4', { url: '/?conversation=2', width: 390 }, 'C'),
        ...shot(BRANCH, 30, 'c2', { url: '/' }, 'A'),
        asks(20, 'ask1'),
        ...shot(BRANCH, 10, 'c0', { url: '/' }, 'OLD'),
      ],
    ],
    [
      DESIGNER,
      [
        ...shot(DESIGNER, 42, 'd2', { url: '/' }, 'B'),
        ...shot(DESIGNER, 40, 'd1', { url: '/', theme: 'dark' }, 'B'),
        ...shot(BRANCH, 10, 'c0', { url: '/' }, 'OLD'),
      ],
    ],
  ])
  const message = (id: number, callId: string): Message => ({
    id,
    from: BRANCH,
    to: 'user',
    text: '',
    at: 0,
    reply: true,
    state: 'sent',
    call: callId,
  })
  const entries = own
  const harness = {
    snapshot: async () => ({ messages: [message(2, 'ask2')], next: 3 }),
    conversation: async (id: ConversationId) => ({
      entries: async ({ maxEntryId }: { maxEntryId?: number }) => ({
        items: (entries.get(id) ?? [])
          .filter((entry) => maxEntryId === undefined || entry.id <= maxEntryId)
          .toSorted((a, b) => b.id - a.id),
      }),
    }),
  }
  const host = {
    conversations: () => [
      { id: BRANCH, label: 'coordinator', busy: false },
      { id: DESIGNER, parentConversationId: BRANCH, label: 'designer', busy: false },
    ],
    harness: () => harness,
  }
  return {
    entries,
    ctx: { host, signal: new AbortController().signal } as unknown as ActionContext,
  }
}

it("plays a question's round across the branch and its subagents, collapsing identical frames", async () => {
  const { entries, ctx } = fixture()
  const reel = await actions.frames({ conversation: BRANCH, message: 2 }, ctx)
  expect(reel).toEqual({
    earlier: 0,
    frames: [
      { conversation: BRANCH, entry: 31, image: 0, agent: 'coordinator', step: '/', count: 1 },
      {
        conversation: DESIGNER,
        entry: 41,
        image: 0,
        agent: 'designer #11',
        step: '/ · dark',
        count: 2,
      },
      {
        conversation: BRANCH,
        entry: 51,
        image: 0,
        agent: 'coordinator',
        step: '/?conversation=2 · 390 px',
        count: 1,
      },
    ],
  })
  for (const frame of reel.frames) {
    const entry = entries.get(frame.conversation)!.find((item) => item.id === frame.entry)
    expect(imagesOf(entry)[frame.image]).toBeDefined()
  }
})

it("a landing's reel spans the whole branch, without a fork's inherited entries", async () => {
  const { ctx } = fixture()
  const reel = await actions.frames({ conversation: BRANCH }, ctx)
  expect(reel.frames.map((frame) => [frame.conversation, frame.entry])).toEqual([
    [BRANCH, 11],
    [BRANCH, 31],
    [DESIGNER, 41],
    [BRANCH, 51],
  ])
})
