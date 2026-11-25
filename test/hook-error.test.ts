import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import {
  fauxAssistantMessage,
  fauxToolCall,
  fauxProvider,
} from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, defineTool, hook, ToolTask } from '@earendil-works/pi-durable'
import { obj } from '@earendil-works/pi-schema'
import { expect, it } from 'vitest'
import { prepareHarness } from '../server/harness.ts'
import { removeTemp, temp, until } from './helpers.ts'

async function callPingPast(thrown: () => unknown) {
  const home = await temp()
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider(),
  })
  let ran = false
  prepared.registry.install(
    defineExtension({
      name: 'broken-guard',
      tools: [
        defineTool({
          name: 'ping',
          description: 'Answers pong',
          parameters: obj({}),
          execute: async () => {
            ran = true
            return { output: [{ type: 'text', text: 'pong' }] }
          },
        }),
      ],
      hooks: [
        hook(ToolTask, {
          beforeTool: async () => {
            throw thrown()
          },
        }),
      ],
    }),
  )
  prepared.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('ping', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage('done'),
  ])
  const f = await prepared.open()
  try {
    await f.root.submit({ type: 'input', content: 'ping' }, context)
    const result = async () =>
      (await f.root.context(context)).entries
        .flatMap((entry) => entry.model ?? [])
        .find((message) => message.role === 'toolResult')
    await until(async () => (await result()) !== undefined)
    const message = await result()
    return { ran, text: message?.role === 'toolResult' ? JSON.stringify(message.content) : '' }
  } finally {
    await f.close()
    await removeTemp(home)
  }
}

// The pi-durable patch: a beforeTool hook that throws still blocks the call, and the message names its extension.
it('a throwing beforeTool hook blocks the call with a message naming its extension', async () => {
  const { ran, text } = await callPingPast(
    () => new TypeError("Cannot read properties of undefined (reading 'seen')"),
  )
  expect(text).toContain(
    "Tool call blocked: the broken-guard extension's beforeTool hook threw: Cannot read properties of undefined (reading 'seen')",
  )
  expect(ran).toBe(false)
})
