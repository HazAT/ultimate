import type { ConversationId, EntryId, EntryRecord } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { actions } from '../server.ts'
import { imagesOf } from '../../../lib/entries.shared.ts'
import type { ActionContext } from '../../../server/actions.ts'
import type { Message } from '../../messages/api.ts'

const BRANCH = 10 as ConversationId
const DESIGNER = 11 as ConversationId

const entry = (conversation: ConversationId, id: number, model: unknown[]) =>
  ({ id: id as EntryId, conversationId: conversation, kind: 'pi', model }) as EntryRecord

const call = (
  conversation: ConversationId,
  id: number,
  callId: string,
  name: string,
  args: Record<string, unknown>,
) =>
  entry(conversation, id, [
    { role: 'assistant', content: [{ type: 'toolCall', id: callId, name, arguments: args }] },
  ])

const result = (
  conversation: ConversationId,
  id: number,
  callId: string,
  toolName: string,
  content: unknown[],
  extra: Record<string, unknown> = {},
) =>
  entry(conversation, id, [
    { role: 'toolResult', toolCallId: callId, toolName, content, isError: false, ...extra },
  ])

function shot(
  conversation: ConversationId,
  id: number,
  callId: string,
  args: Record<string, unknown>,
  pixels: string,
) {
  return [
    result(conversation, id + 1, callId, 'browser', [
      { type: 'text', text: 'note' },
      { type: 'image', mimeType: 'image/png', data: pixels },
      { type: 'text', text: 'Title' },
    ]),
    call(conversation, id, callId, 'browser', args),
  ]
}

const ask = (id: number, callId: string, args: Record<string, unknown> = {}, sent = true) => [
  result(BRANCH, id + 1, callId, 'message', [
    { type: 'text', text: sent ? 'Message 9 sent.' : 'images: entry 3 has no images' },
  ]),
  call(BRANCH, id, callId, 'message', { to: 'user', text: 'Preview?', ...args }),
]

const script = (id: number, callId: string, failed = false) => [
  result(BRANCH, id + 1, callId, 'codemode', [{ type: 'text', text: 'done' }], {
    isError: failed,
  }),
  call(BRANCH, id, callId, 'codemode', { code: '…' }),
]

const both = (id: number, first: string, second: string) => [
  entry(
    BRANCH,
    id + 1,
    [first, second].map((callId) => ({
      role: 'toolResult',
      toolCallId: callId,
      toolName: 'message',
      content: [{ type: 'text', text: 'Message 9 sent.' }],
      isError: false,
    })),
  ),
  entry(BRANCH, id, [
    {
      role: 'assistant',
      content: [first, second].map((callId) => ({
        type: 'toolCall',
        id: callId,
        name: 'message',
        arguments: { to: 'user', text: callId },
      })),
    },
  ]),
]

function fixture(branch: EntryRecord[], log: Message[], asked: string[] = []) {
  const own = new Map<ConversationId, EntryRecord[]>([
    [BRANCH, branch],
    [
      DESIGNER,
      [
        ...shot(DESIGNER, 42, 'd2', { url: '/' }, 'B'),
        ...shot(DESIGNER, 40, 'd1', { url: '/', theme: 'dark' }, 'B'),
        ...shot(BRANCH, 30, 'c2', { url: '/' }, 'A'),
      ],
    ],
  ])
  const harness = {
    snapshot: async (token: { definition: { kind: string } }) =>
      token.definition.kind === 'board.asked-calls'
        ? { calls: asked }
        : { messages: log, next: 100 },
    conversation: async (id: ConversationId) => ({
      entries: async ({
        maxEntryId,
        minEntryId,
        order,
      }: {
        maxEntryId?: number
        minEntryId?: number
        order?: string
      }) => ({
        items: (own.get(id) ?? [])
          .filter((item) => maxEntryId === undefined || item.id <= maxEntryId)
          .filter((item) => minEntryId === undefined || item.id >= minEntryId)
          .toSorted((a, b) => (order === 'ascending' ? a.id - b.id : b.id - a.id)),
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
    own,
    ctx: { host, signal: new AbortController().signal } as unknown as ActionContext,
  }
}

const question = (id: number, callId: string): Message => ({
  id,
  from: BRANCH,
  to: 'user',
  text: '',
  at: 0,
  reply: true,
  state: 'delivered',
  call: callId,
})

const round = [
  ...ask(60, 'ask2'),
  ...shot(BRANCH, 50, 'c4', { url: '/?conversation=2', width: 390 }, 'C'),
  ...shot(BRANCH, 30, 'c2', { url: '/' }, 'A'),
  ...ask(20, 'ask1'),
  ...shot(BRANCH, 10, 'c0', { url: '/' }, 'OLD'),
]

it("plays a question's round across the branch and its subagents, from its own history", async () => {
  const { own, ctx } = fixture(round, [question(2, 'ask2')], ['ask1'])
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
    const stored = own.get(frame.conversation)!.find((item) => item.id === frame.entry)
    expect(imagesOf(stored)[frame.image]).toBeDefined()
  }
})

// A one-way report between two questions cut the next question's reel short.
it('a one-way report to the user is no round boundary', async () => {
  const branch = [
    ...ask(60, 'ask2'),
    ...shot(BRANCH, 50, 'c4', { url: '/' }, 'C'),
    ...ask(40, 'fyi'),
    ...shot(BRANCH, 30, 'c2', { url: '/' }, 'A'),
    ...ask(20, 'ask1'),
  ]
  const fyi = { ...question(1, 'fyi'), reply: false }
  const { ctx } = fixture(branch, [fyi, question(2, 'ask2')], ['ask1'])
  const reel = await actions.frames({ conversation: BRANCH, message: 2 }, ctx)
  expect(reel.frames.map((frame) => frame.entry)).toEqual([31, 41, 51])
})

it('a failed send is no round boundary', async () => {
  const branch = [
    ...ask(60, 'ask2'),
    ...shot(BRANCH, 50, 'c4', { url: '/' }, 'C'),
    ...ask(40, 'retry', { reply: true }, false),
    ...shot(BRANCH, 30, 'c2', { url: '/' }, 'A'),
    ...ask(20, 'ask1'),
  ]
  const { ctx } = fixture(branch, [question(2, 'ask2')])
  const reel = await actions.frames({ conversation: BRANCH, message: 2 }, ctx)
  expect(reel.frames.map((frame) => frame.entry)).toEqual([31, 41, 51])
})

it('a question asked from a script starts after the one before it', async () => {
  const branch = [
    ...script(60, 'run'),
    ...shot(BRANCH, 50, 'c4', { url: '/' }, 'C'),
    ...script(20, 'older'),
  ]
  const asked = ['older/c2', 'run/c1', 'run/c3']
  const { ctx } = fixture(branch, [question(3, 'run/c1'), question(4, 'run/c3')], asked)
  const first = await actions.frames({ conversation: BRANCH, message: 3 }, ctx)
  const second = await actions.frames({ conversation: BRANCH, message: 4 }, ctx)
  expect(first.frames.map((frame) => frame.entry)).toEqual([41, 51])
  expect(second.frames).toEqual([])
})

it('keeps a scripted question apart once the log no longer holds the one before it, @ultimate’s too', async () => {
  const branch = [
    ...script(60, 'run'),
    ...shot(BRANCH, 50, 'c4', { url: '/' }, 'C'),
    ...script(20, 'older'),
  ]
  const trimmed = fixture(branch, [question(4, 'run/c3')], ['older/c2', 'run/c1', 'run/c3']).ctx
  expect((await actions.frames({ conversation: BRANCH, message: 4 }, trimmed)).frames).toEqual([])
})

it('a script that asked and then failed still ends its round', async () => {
  const branch = [
    ...ask(60, 'ask2'),
    ...shot(BRANCH, 50, 'c4', { url: '/' }, 'C'),
    ...script(40, 'failing', true),
    ...shot(BRANCH, 30, 'c2', { url: '/' }, 'A'),
  ]
  const { ctx } = fixture(branch, [question(2, 'ask2')], ['failing/c1'])
  const reel = await actions.frames({ conversation: BRANCH, message: 2 }, ctx)
  expect(reel.frames.map((frame) => frame.entry)).toEqual([41, 51])
})

it('two questions sent in one turn: the first gets the round, the second none', async () => {
  const branch = [
    ...both(60, 'qa', 'qb'),
    ...shot(BRANCH, 50, 'c4', { url: '/' }, 'C'),
    ...ask(40, 'ask0'),
  ]
  const { ctx } = fixture(branch, [question(5, 'qa'), question(6, 'qb')])
  const first = await actions.frames({ conversation: BRANCH, message: 5 }, ctx)
  const second = await actions.frames({ conversation: BRANCH, message: 6 }, ctx)
  expect(first.frames.map((frame) => frame.entry)).toEqual([41, 51])
  expect(second.frames).toEqual([])
})

it('a question still running has its round, and a frame between two questions shows once', async () => {
  const branch = [
    call(BRANCH, 60, 'ask2', 'message', { to: 'user', text: 'Preview?' }),
    ...shot(BRANCH, 50, 'c4', { url: '/' }, 'C'),
    ...ask(40, 'ask1'),
    ...shot(BRANCH, 30, 'c2', { url: '/' }, 'A'),
  ]
  const { ctx } = fixture(branch, [question(1, 'ask1'), question(2, 'ask2')])
  const first = await actions.frames({ conversation: BRANCH, message: 1 }, ctx)
  const second = await actions.frames({ conversation: BRANCH, message: 2 }, ctx)
  expect(first.frames.map((frame) => frame.entry)).toEqual([31])
  expect(second.frames.map((frame) => frame.entry)).toEqual([41, 51])
})

it("a landing's reel spans the whole branch, without a fork's inherited entries", async () => {
  const { ctx } = fixture(round, [])
  const reel = await actions.frames({ conversation: BRANCH }, ctx)
  expect(reel.frames.map((frame) => [frame.conversation, frame.entry, frame.count])).toEqual([
    [BRANCH, 11, 1],
    [BRANCH, 31, 1],
    [DESIGNER, 41, 2],
    [BRANCH, 51, 1],
  ])
})
