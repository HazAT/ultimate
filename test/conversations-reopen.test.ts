import { resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { context } from '../server/harness.ts'
import { UiState } from '../shared/ui-state.ts'
import { fauxServer, post, temp, until } from './helpers.ts'

async function fixture() {
  const home = await temp('ultimate-reopen-')
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: home,
    userHome: home,
    home,
  })
  const seed = await server.harness.commit(
    (tx) => tx.appendEntry(server.root.id, { kind: 'test.seed' }),
    context,
  )
  const child = await server.root.fork(seed.id, { ownership: { kind: 'ownerless' } }, context)
  const childSeed = await server.harness.commit(
    (tx) => tx.appendEntry(child.id, { kind: 'test.seed' }),
    context,
  )
  const descendant = await child.fork(childSeed.id, { ownership: { kind: 'ownerless' } }, context)
  const unrelated = await server.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  const conclude = (ids: number[]) =>
    server.harness.commit(async (tx) => {
      const ui = await tx.doc(UiState, ROOT_CONVERSATION_ID)
      ui['ext.conversations.concluded'] = ids
      ui['test.preserved'] = 'keep'
    }, context)
  const concluded = async () =>
    (await server.harness.snapshot(UiState, ROOT_CONVERSATION_ID, context))![
      'ext.conversations.concluded'
    ] as number[]
  return { server, child, descendant, unrelated, conclude, concluded }
}

it('a write starts no run and resumes nothing', async () => {
  const { server, child, descendant, unrelated, conclude, concluded } = await fixture()
  try {
    const all = [server.root.id, child.id, descendant.id, unrelated.id]
    await conclude(all)
    await (
      await descendant.submit(
        {
          type: 'write',
          entry: { kind: 'test.note', model: [{ role: 'user', content: 'note', timestamp: 1 }] },
        },
        context,
      )
    ).wait(context)
    expect(await concluded()).toEqual(all)
  } finally {
    await server.close()
  }
})

it('resumes ancestors in the commit that places any input, typed or extension', async () => {
  const f = await fixture()
  try {
    for (const entry of [undefined, { kind: 'board.message', data: { id: 1 } }]) {
      await f.conclude([f.server.root.id, f.child.id, f.descendant.id, f.unrelated.id])
      const receipt = await f.descendant.submit(
        { type: 'input', content: 'Resume this work', ...(entry && { entry }) },
        context,
      )
      // Placement and resume share one commit: the list is already updated when submit returns.
      expect(await f.concluded()).toEqual([f.unrelated.id])
      await receipt.wait(context)
    }
    expect(await f.server.harness.snapshot(UiState, ROOT_CONVERSATION_ID, context)).toMatchObject({
      'test.preserved': 'keep',
    })
  } finally {
    await f.server.close()
  }
})

it('a message, and one sent by an automation run, resume a concluded recipient', async () => {
  const f = await fixture()
  try {
    const target = f.unrelated.id
    await f.conclude([target])
    // Every run, typed or an automation's, sends `target` a one-way message, then answers.
    const route: FauxResponseFactory = (transcript) => {
      f.server.host.faux!.appendResponses([route])
      return transcript.messages.at(-1)?.role === 'toolResult'
        ? fauxAssistantMessage('Sent.')
        : fauxAssistantMessage(
            [fauxToolCall('message', { to: `#${target}`, text: 'Check this.', reply: false })],
            { stopReason: 'toolUse' },
          )
    }
    f.server.host.faux!.setResponses([route])
    await f.server.root.submit({ type: 'input', content: `message #${target} one-way` }, context)
    await until(async () => !(await f.concluded()).includes(target))
    await f.server.harness.waitForIdle(context)

    await f.conclude([target])
    const action = (name: string, args: object) =>
      post(f.server, `/api/extensions/automations/actions/${name}`, { args })
    const created = await action('create', {
      name: 'relay',
      prompt: `message #${target} one-way`,
      schedule: 'in 1h',
    })
    expect(created).toMatchObject({ status: 200, data: { result: { id: 'A1' } } })
    expect((await action('run', { id: 'A1' })).status).toBe(200)
    await until(async () => !(await f.concluded()).includes(target))
    await f.server.harness.waitForIdle(context)
  } finally {
    await f.server.close()
  }
})
