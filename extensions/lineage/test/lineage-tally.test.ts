import { expect, it } from 'vitest'
import { CompactionTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { TaskId } from '@earendil-works/pi-durable'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { context } from '../../../server/harness.ts'
import { fauxServer, post, seedTally, sourceCopy, temp } from '../../../test/helpers.ts'

it('compacts a tally once at a time with the root focus and the given instructions', async () => {
  const home = await temp()
  const server = await fauxServer({ ultimateRoot: await sourceCopy(home), home, userHome: home })
  const compacting = Promise.withResolvers<void>()
  const finishCompact = Promise.withResolvers<void>()
  try {
    const compact = async (args: unknown) =>
      (await post(server, '/api/extensions/lineage/actions/compact', { args })).data
    const tools = server.host.registry.snapshot().extension('lineage')!.tools!
    for (const name of ['new_root', 'seed_tally', 'compact_tally'])
      expect(tools.map((tool) => tool.name)).not.toContain(name)
    const id = ROOT_CONVERSATION_ID
    await seedTally(server.harness)
    await server.harness.commit(async (tx) => {
      for (let n = 0; n < 8; n++)
        await tx.appendEntry(id, {
          kind: 'pi.user',
          model: [{ role: 'user', content: `Part ${n} ${'word '.repeat(4000)}`, timestamp: n }],
        })
    }, context)
    let prompt = ''
    server.host.faux!.setResponses([
      async (transcript) => {
        prompt = JSON.stringify(transcript.messages)
        compacting.resolve()
        await finishCompact.promise
        return fauxAssistantMessage(
          'Root summary: keep standing decisions and #conversation/entry.',
        )
      },
    ])
    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        compact({ id, instructions: 'Drop the obsolete deployment plan.' }),
      ),
    )
    expect(results.filter((result) => result.result)).toHaveLength(1)
    expect(results.find((result) => result.error)?.error).toBe(`#${id} is already compacting`)
    const tasks = await server.harness.commit(
      (tx) => tx.scanTasks({ conversationId: id, kind: CompactionTask.definition.name }, 10),
      context,
    )
    expect(tasks.items).toHaveLength(1)
    const taskId = results.find((result) => result.result)!.result.taskId as TaskId
    await compacting.promise
    expect((await compact({ id })).error).toBe(`#${id} is already compacting`)
    finishCompact.resolve()
    expect((await server.harness.waitForTask(taskId, context)).state.outcome.status).toBe(
      'completed',
    )
    expect(prompt).toContain('This is the tally of one line of work')
    expect(prompt).toContain('standing decisions')
    expect(prompt).toContain('Drop the obsolete deployment plan.')
    expect(JSON.stringify((await server.root.context(context)).messages)).toContain('Root summary')
  } finally {
    finishCompact.resolve()
    await server.close()
  }
})
