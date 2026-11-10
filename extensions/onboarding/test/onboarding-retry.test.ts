import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { context } from '../../../server/harness.ts'
import { fauxServer, post, removeTemp, temp } from '../../../test/helpers.ts'

// #552022: a start before any model failed its run, and every later start was deduplicated into that failure.
it('starts onboarding once a model appears after a start that failed without one', async () => {
  const home = await temp('ultimate-onboarding-retry-')
  const server = await fauxServer({ ultimateRoot: '.', home, userHome: home })
  const requests: string[] = []
  server.host.faux!.setResponses(
    Array.from({ length: 5 }, () => (transcript: { messages: { content: unknown }[] }) => {
      requests.push(JSON.stringify(transcript.messages.at(-1)?.content))
      return fauxAssistantMessage('Welcome. First beat of the walkthrough.')
    }),
  )
  const start = () =>
    post(server, '/api/extensions/onboarding/actions/start', { args: { root: 1 } })
  try {
    const id = (
      await post(server, '/api/extensions/subagents/actions/standing', {
        args: { name: 'ultimate' },
      })
    ).data.result as ConversationId
    const ultimate = (await server.harness.conversation(id, context))!
    const faux = (await ultimate.agent(context)).model!
    // No model this machine can run.
    await ultimate.configure({ model: { provider: 'missing', modelId: 'unknown' } }, context)
    expect((await start()).data.result).toEqual({ id })
    await server.harness.waitForIdle(context)
    expect(requests).toEqual([])

    // A login appears, then Get ready's Continue and the card both start: one walkthrough.
    await ultimate.configure({ model: faux }, context)
    const [a, b] = await Promise.all([start(), start()])
    expect([a.data.result, b.data.result]).toEqual([{ id }, { id }])
    await server.harness.waitForIdle(context)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain('Onboarding started.')
    const entries = (await ultimate.context(context)).entries
    expect(entries.filter((entry) => entry.kind === 'onboarding.start')).toHaveLength(1)
    expect(entries.at(-1)?.model?.[0]).toMatchObject({ role: 'assistant' })

    // Once it answered, a later start sends nothing.
    await start()
    await server.harness.waitForIdle(context)
    expect(requests).toHaveLength(1)
  } finally {
    await server.close()
    await removeTemp(home)
  }
})
