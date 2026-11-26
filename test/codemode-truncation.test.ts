import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import {
  fauxAssistantMessage,
  fauxToolCall,
  fauxProvider,
} from '@earendil-works/pi-ai/providers/faux'
import { InlineCodemodeSandbox, loadQuickJSWasm } from '@earendil-works/pi-codemode'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode'
import { obj } from '@earendil-works/pi-schema'
import { expect, it } from 'vitest'
import { prepareHarness } from '../server/harness.ts'
import { removeTemp, temp, until } from './helpers.ts'

// The pi-durable patch: a script reads where the Harness cut a nested call's output, as the model does.
it('a codemode script sees that the output of a tool it called was cut', async () => {
  const home = await temp()
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider(),
  })
  const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() })
  prepared.registry.install(createCodemodeExtension({ sandbox, models: false }))
  prepared.registry.install(
    defineExtension({
      name: 'large',
      tools: [
        defineTool({
          name: 'large',
          description: 'Answers with 3000 lines',
          parameters: obj({}),
          execute: async () => ({ output: [{ type: 'text', text: 'line\n'.repeat(3000) }] }),
        }),
      ],
    }),
  )
  prepared.faux!.setResponses([
    fauxAssistantMessage(
      [fauxToolCall('codemode', { code: 'return (await tools.large({})).slice(-100)' })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('done'),
  ])
  const f = await prepared.open()
  try {
    await f.root.submit({ type: 'input', content: 'read it' }, context)
    const result = async () =>
      (await f.root.context(context)).entries
        .flatMap((entry) => entry.model ?? [])
        .find((message) => message.role === 'toolResult')
    await until(async () => (await result()) !== undefined)
    const message = await result()
    expect(JSON.stringify(message?.role === 'toolResult' && message.content)).toContain(
      'line\\n\\n[Output truncated to its beginning: 1000 lines, 5000 bytes dropped]',
    )
  } finally {
    await f.close()
    await sandbox.close()
    await removeTemp(home)
  }
})
