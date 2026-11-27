import { afterEach, beforeAll, expect, it } from 'vitest'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { Message } from '@earendil-works/pi-ai'
import { AgentDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { context } from '../../../server/harness.ts'
import { fauxServer, post, sourceCopy, temp, until } from '../../../test/helpers.ts'

import { Calls } from '../server.ts'

let ultimateRoot: string
const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp())
})
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function fixture() {
  const home = await temp('ultimate-page-agent-')
  const server = await fauxServer({ ultimateRoot, home, userHome: home })
  servers.push(server)
  const requests: Message[][] = []
  const route: FauxResponseFactory = (transcript) => {
    server.host.faux!.appendResponses([route])
    requests.push(transcript.messages)
    return transcript.messages.at(-1)!.role === 'user'
      ? fauxAssistantMessage([fauxToolCall('ui', { op: 'query', text: 'Secrets' })], {
          stopReason: 'toolUse',
        })
      : fauxAssistantMessage('done')
  }
  server.host.faux!.setResponses([route])
  const conversation = await server.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  const id = conversation.id
  expect((await conversation.agent(context)).tools.map((tool) => tool.name)).not.toContain('ui')
  await server.harness.commit(async (tx) => {
    Object.assign(await tx.doc(AgentDoc, id), {
      model: { provider: 'faux', modelId: 'faux-1' },
      modelTools: { add: ['ui'] },
    })
  }, context)
  await conversation.submit({ type: 'input', content: 'look' }, context)
  const calls = () => server.harness.snapshot(Calls, ROOT_CONVERSATION_ID, context)
  await until(async () => ((await calls())?.calls.length ?? 0) > 0)
  const action = (name: string, args: unknown) =>
    post(server, `/api/extensions/page-agent/actions/${name}`, { args })
  return { server, id, conversation, requests, calls, action, call: (await calls())!.calls[0] }
}

it('a visible page claims an unnamed request first, and only its answer is the result', async () => {
  const f = await fixture()
  expect(f.call).toMatchObject({ conversation: f.id, op: 'query', input: { text: 'Secrets' } })
  expect(f.call.page).toBeUndefined()
  const claim = (page: string, visible: boolean) =>
    f.action('claim', { id: f.call.id, page, visible })
  expect((await claim('hidden', false)).data.result).toEqual({ claimed: false })
  expect((await claim('page-a', true)).data.result).toEqual({ claimed: true })
  expect((await claim('page-b', true)).data.result).toEqual({ claimed: false })
  await f.action('answer', { id: f.call.id, page: 'page-b', result: ['from the wrong page'] })
  expect((await f.calls())!.calls).toHaveLength(1)
  const answered = await f.action('answer', {
    id: f.call.id,
    page: 'page-a',
    result: [{ ref: 'c7', label: 'Secrets' }],
  })
  expect(answered.status).toBe(200)
  await f.conversation.waitForIdle(context)
  const result = f.requests.at(-1)!.at(-1)!
  expect(result.role === 'toolResult' && result.content).toEqual([
    { type: 'text', text: '[{"ref":"c7","label":"Secrets"}]' },
  ])
  expect((await f.calls())!.calls).toEqual([])
})

it('a claimed request that times out unanswered warns that it may have run', async () => {
  const f = await fixture()
  await f.action('claim', { id: f.call.id, page: 'page-a', visible: true })
  const ui = f.server.host.registry
    .snapshot()
    .extension('page-agent')!
    .tools!.find((tool) => tool.name === 'ui')!
  const timedOut = await ui.execute(
    { op: 'act', steps: [] },
    {
      callId: f.call.id,
      wake: { reason: 'time' },
      readSignal: async () => undefined,
      commit: (change: never) => f.server.harness.commit(change, context),
    } as never,
    context,
  )
  expect(timedOut).toMatchObject({
    isError: true,
    output: [{ text: expect.stringContaining('Look before repeating it') }],
  })
  expect((await f.calls())!.calls).toEqual([])
})

it('only the named page may claim a request, visible or not', async () => {
  const f = await fixture()
  await f.server.harness.commit(async (tx) => {
    ;(await tx.doc(Calls, ROOT_CONVERSATION_ID)).calls[0].page = 'voice-page'
  }, context)
  const claim = (page: string, visible: boolean) =>
    f.action('claim', { id: f.call.id, page, visible })
  expect((await claim('other', true)).data.result).toEqual({ claimed: false })
  expect((await claim('voice-page', false)).data.result).toEqual({ claimed: true })
})
