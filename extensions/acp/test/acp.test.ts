import type { ConversationId, EntryDraft, Tx } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { apply, settleTurn } from '../server.ts'
import { fileLinksAsPaths } from '../tools.ts'

const ID = 7 as ConversationId
const metadata = { definition: { kind: 'ultimate.metadata', initial: () => ({}) } }

function fakeTx() {
  const docs = new Map<string, object>([['acp.session', { agent: 'antigravity' }]])
  const entries: EntryDraft[] = []
  const tx = {
    doc: async ({ definition: def }: { definition: { kind: string; initial: () => object } }) => {
      if (!docs.has(def.kind)) docs.set(def.kind, def.initial())
      return docs.get(def.kind)
    },
    appendEntry: async (_id: ConversationId, entry: EntryDraft) => {
      entries.push(entry)
      return { ...entry, id: entries.length }
    },
  } as unknown as Tx
  return { tx, entries, docs }
}
const run = async (tx: Tx, ...updates: Record<string, unknown>[]) => {
  for (const update of updates)
    await apply(tx, ID, update, metadata as unknown as ExtensionHost['metadata'])
}
const shape = (entries: EntryDraft[]) =>
  entries.map((entry) => {
    const message = entry.model?.[0]
    if (message?.role === 'toolResult') return `${entry.kind} ${message.toolName}`
    if (message?.role !== 'assistant') return entry.kind
    return `${entry.kind} ${message.content.map((block) => (block.type === 'toolCall' ? `call:${block.name}` : block.type)).join(',')}`
  })

it('streams an agent turn into native entries: thinking, a tool with its result, then the answer', async () => {
  const { tx, entries } = fakeTx()
  await run(
    tx,
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Look at ' } },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'the file' } },
    {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      kind: 'read',
      status: 'pending',
      title: 'Read',
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      locations: [{ path: '/repo/package.json' }],
      content: [{ type: 'content', content: { type: 'text', text: '{"name":"x"}' } }],
    },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'It is ' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x.' } },
  )
  expect(shape(entries)).toEqual([
    'pi.assistant thinking',
    'pi.assistant call:read',
    'pi.tool-result read',
  ])
  await settleTurn(tx, ID)
  expect(shape(entries).at(-1)).toBe('pi.assistant text')
  const thought = entries[0].model?.[0]
  expect(thought?.role === 'assistant' && thought.content[0]).toMatchObject({
    thinking: 'Look at the file',
  })
  const call = entries[1].model?.[0]
  expect(call?.role === 'assistant' && call.content[0]).toMatchObject({
    arguments: { path: '/repo/package.json' },
  })
  const answer = entries[3].model?.[0]
  expect(answer?.role === 'assistant' && answer.content[0]).toMatchObject({ text: 'It is x.' })
})

it('turns an ACP diff into an edit call whose result carries a patch for the diff card', async () => {
  const { tx, entries } = fakeTx()
  await run(tx, {
    sessionUpdate: 'tool_call',
    toolCallId: 'e1',
    kind: 'edit',
    status: 'completed',
    content: [{ type: 'diff', path: '/repo/a.txt', oldText: 'hi\n', newText: 'hello\n' }],
  })
  expect(shape(entries)).toEqual(['pi.assistant call:edit', 'pi.tool-result edit'])
  const result = entries[1].model?.[0]
  const details = result?.role === 'toolResult' ? (result.details as { patch: string }) : undefined
  expect(details?.patch).toContain('-hi\n+hello')
})

it('shows file:// links, which the transcript blocks, as code paths', () => {
  expect(
    fileLinksAsPaths('See [neon.txt](file:///tmp/a%20b/neon.txt) and [the file](file:///x/y.ts).'),
  ).toBe('See `/tmp/a b/neon.txt` and the file (`/x/y.ts`).')
})

it('closes a call the agent never finished when its turn ends, so no card stays running', async () => {
  const { tx, entries } = fakeTx()
  await run(tx, {
    sessionUpdate: 'tool_call',
    toolCallId: 'x1',
    kind: 'execute',
    status: 'in_progress',
    rawInput: { command: 'sleep 100' },
  })
  expect(entries).toEqual([])
  await settleTurn(tx, ID)
  expect(shape(entries)).toEqual(['pi.assistant call:bash', 'pi.tool-result bash'])
  const result = entries[1].model?.[0]
  expect(result?.role === 'toolResult' && result.isError).toBe(true)
})
