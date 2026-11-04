import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { leaveNote, Notified } from '../extensions/lineage/server.ts'
import { context } from '../server/harness.ts'
import { until } from './helpers.ts'
import {
  ask,
  branchFrom,
  fixture,
  kinds,
  notifyFixture,
  pendingNotifies,
  second,
  servers,
  textOf,
} from './lineage-fixture.ts'

it.concurrent('wakes the caller once when the conversation it waits on finishes', async () => {
  const { server, release } = await notifyFixture()
  const other = await second(server)
  const held = (await server.harness.conversation(other.id, context))!.submit(
    { type: 'input', content: 'HOLD' },
    context,
  )
  await held
  await ask(server, ROOT_CONVERSATION_ID, `NOTIFY ${JSON.stringify({ id: other.id })}`)
  expect(await pendingNotifies(server)).toHaveLength(1)
  expect(await kinds(server, ROOT_CONVERSATION_ID)).not.toContain('lineage.finished')
  release()
  await until(async () => (await pendingNotifies(server)).length === 0)
  await server.root.waitForIdle(context)
  const view = await server.root.context(context)
  const finished = view.entries.filter((entry) => entry.kind === 'lineage.finished')
  expect(finished).toHaveLength(1)
  expect(finished[0].data).toEqual({ from: other.id, title: 'HOLD', text: 'echo HOLD' })
  expect(textOf(finished[0].model?.[0]?.content)).toBe(
    `#${other.id} finished · HOLD\n\nIts last answer:\necho HOLD`,
  )
  // The delivery started a run that answered it.
  expect(view.entries.at(-1)!.kind).toBe('pi.assistant')
  expect(textOf(view.entries.at(-1)!.model?.[0]?.content)).toContain(`#${other.id} finished`)
})

it.concurrent('leaves a note without waking the caller when wake is false', async () => {
  const { server } = await notifyFixture()
  const other = await second(server)
  await ask(server, other.id, 'Done already')
  await ask(server, ROOT_CONVERSATION_ID, `NOTIFY ${JSON.stringify({ id: other.id, wake: false })}`)
  await until(async () => (await kinds(server, ROOT_CONVERSATION_ID)).includes('lineage.note'))
  await until(async () => (await pendingNotifies(server)).length === 0)
  const view = await server.root.context(context)
  const note = view.entries.at(-1)!
  expect(note.kind).toBe('lineage.note')
  expect(note.data).toEqual({
    text: 'echo Done already',
    from: other.id,
    source: 'finished',
    title: 'Done already',
  })
  expect(
    (await server.harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context))?.run,
  ).toBeUndefined()
})

it.concurrent('re-armed on an idle target, waits for its next answer instead of repeating one', async () => {
  const { server } = await notifyFixture()
  const other = await second(server)
  await ask(server, other.id, 'First')
  const finished = async () =>
    (await server.root.context(context)).entries.filter(
      (entry) => entry.kind === 'lineage.finished' || entry.kind === 'lineage.note',
    )
  await ask(server, ROOT_CONVERSATION_ID, `NOTIFY ${JSON.stringify({ id: other.id })}`)
  await until(async () => (await pendingNotifies(server)).length === 0)
  await server.root.waitForIdle(context)
  expect((await finished()).map((entry) => entry.data)).toEqual([
    { from: other.id, title: 'First', text: 'echo First' },
  ])

  // Both modes stay pending while the target is idle with the answer already delivered.
  await ask(server, ROOT_CONVERSATION_ID, `NOTIFY ${JSON.stringify({ id: other.id })}`)
  await server.root.waitForIdle(context)
  expect(await pendingNotifies(server)).toHaveLength(1)
  await ask(server, ROOT_CONVERSATION_ID, `NOTIFY ${JSON.stringify({ id: other.id, wake: false })}`)
  await server.root.waitForIdle(context)
  expect(await pendingNotifies(server)).toHaveLength(1)
  expect(await finished()).toHaveLength(1)

  await ask(server, other.id, 'Second')
  await until(async () => (await pendingNotifies(server)).length === 0)
  const delivered = await finished()
  expect(delivered).toHaveLength(2)
  expect(delivered[1].kind).toBe('lineage.note')
  expect(delivered[1].data).toMatchObject({ from: other.id, text: 'echo Second' })
})

it.concurrent('does not repeat an answer the caller already received as a reply', async () => {
  const { server } = await notifyFixture()
  const other = await second(server)
  await ask(
    server,
    ROOT_CONVERSATION_ID,
    `SEND ${JSON.stringify({ to: `#${other.id}`, text: 'Dry run' })}`,
  )
  await until(async () => (await kinds(server, ROOT_CONVERSATION_ID)).includes('board.reply'))
  await other.waitForIdle(context)
  await server.root.waitForIdle(context)

  await ask(server, ROOT_CONVERSATION_ID, `NOTIFY ${JSON.stringify({ id: other.id })}`)
  await server.root.waitForIdle(context)
  expect(await kinds(server, ROOT_CONVERSATION_ID)).not.toContain('lineage.finished')
  expect(await pendingNotifies(server)).toHaveLength(1)

  // Its next answer is new to the caller: that one is delivered.
  await ask(server, other.id, 'Published')
  await until(async () => (await pendingNotifies(server)).length === 0)
  const finished = (await server.root.context(context)).entries.filter(
    (entry) => entry.kind === 'lineage.finished',
  )
  expect(finished.map((entry) => entry.data)).toEqual([
    { from: other.id, title: expect.any(String), text: 'echo Published' },
  ])
})

it.concurrent('a replacing notify finds the delivery its aborted predecessor made before recording it', async () => {
  const { server } = await notifyFixture()
  const other = await second(server)
  await ask(server, other.id, 'Once')
  await ask(server, ROOT_CONVERSATION_ID, `NOTIFY ${JSON.stringify({ id: other.id })}`)
  await until(async () => (await pendingNotifies(server)).length === 0)
  await server.root.waitForIdle(context)
  // As if the re-arm aborted the task after its submit and before its record.
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Notified, ROOT_CONVERSATION_ID)).answers = {}
  }, context)
  await ask(server, ROOT_CONVERSATION_ID, `NOTIFY ${JSON.stringify({ id: other.id, wake: false })}`)
  await until(async () => (await pendingNotifies(server)).length === 0)
  const entries = await kinds(server, ROOT_CONVERSATION_ID)
  expect(entries.filter((kind) => kind === 'lineage.finished')).toHaveLength(1)
  expect(entries).not.toContain('lineage.note')
  expect(
    (await server.harness.snapshot(Notified, ROOT_CONVERSATION_ID, context))?.answers[other.id],
  ).toBeGreaterThan(0)
})

it.concurrent('a deliver resumed after a restart finds the note it left under its task id', async () => {
  const { server, home } = await notifyFixture()
  const other = await second(server)
  await (await server.harness.conversation(other.id, context))!.submit(
    { type: 'input', content: 'HOLD' },
    context,
  )
  await ask(server, ROOT_CONVERSATION_ID, `NOTIFY ${JSON.stringify({ id: other.id, wake: false })}`)
  const [task] = await pendingNotifies(server)
  // The code before answer-keyed ids left its note under the task id, then the process stopped.
  await leaveNote({ harness: () => server.harness }, ROOT_CONVERSATION_ID, 'Old answer', {
    from: other.id,
    source: 'finished',
    requestId: `lineage:notify:${other.id}:${task.id}`,
  })
  await server.close()
  servers.splice(servers.indexOf(server), 1)
  const database = new DatabaseSync(join(home, 'state.sqlite'))
  const record = JSON.parse(
    (database.prepare('SELECT record FROM tasks WHERE id = ?').get(task.id) as { record: string })
      .record,
  )
  record.state = {
    status: 'pending',
    checkpoint: { phase: 'deliver', text: 'Old answer', answer: 1 },
  }
  database
    .prepare("UPDATE tasks SET status = 'pending', record = ? WHERE id = ?")
    .run(JSON.stringify(record), task.id)
  database.close()

  const { server: reopened, release } = await notifyFixture(home)
  release()
  await until(async () => (await pendingNotifies(reopened)).length === 0)
  const entries = await kinds(reopened, ROOT_CONVERSATION_ID)
  expect(entries.filter((kind) => kind === 'lineage.note')).toHaveLength(1)
  expect(
    (await reopened.harness.snapshot(Notified, ROOT_CONVERSATION_ID, context))?.answers[other.id],
  ).toBe(1)
})

it.concurrent('keeps one pending notify per target and delivers it once across a reopen', async () => {
  const { server, home } = await notifyFixture()
  const other = await second(server)
  await (await server.harness.conversation(other.id, context))!.submit(
    { type: 'input', content: 'HOLD' },
    context,
  )
  await ask(server, ROOT_CONVERSATION_ID, `NOTIFY ${JSON.stringify({ id: other.id })}`)
  await ask(server, ROOT_CONVERSATION_ID, `NOTIFY ${JSON.stringify({ id: other.id, wake: false })}`)
  const pending = await pendingNotifies(server)
  expect(pending.map((task) => task.input)).toEqual([{ target: other.id, wake: false }])

  await server.close()
  servers.splice(servers.indexOf(server), 1)
  const { server: reopened, release } = await notifyFixture(home)
  expect(await pendingNotifies(reopened)).toHaveLength(1)
  release()
  await until(async () => (await pendingNotifies(reopened)).length === 0)
  await reopened.root.waitForIdle(context)
  const entries = await kinds(reopened, ROOT_CONVERSATION_ID)
  expect(entries.filter((kind) => kind === 'lineage.note')).toHaveLength(1)
  expect(entries).not.toContain('lineage.finished')
})

it.concurrent('notifies after the branch’s run without waiting for the branch’s own pending notify', async () => {
  const { server } = await fixture()
  const other = await second(server)
  const run = Promise.withResolvers<void>()
  const unrelated = Promise.withResolvers<void>()
  const runStarted = Promise.withResolvers<void>()
  const otherStarted = Promise.withResolvers<void>()
  const intent = `NOTIFY ${JSON.stringify({ id: other.id, wake: false })}`
  const route: FauxResponseFactory = async (transcript) => {
    server.host.faux!.appendResponses([route])
    // A system prompt that changed since the last run follows the history the branch inherited.
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    const text = textOf(last.content)
    if (last.role === 'toolResult') return fauxAssistantMessage('Branch run finished')
    if (text === 'HOLD') {
      otherStarted.resolve()
      await unrelated.promise
    }
    if (text === intent) {
      runStarted.resolve()
      await run.promise
    }
    if (text.startsWith('NOTIFY '))
      return fauxAssistantMessage([fauxToolCall('notify', JSON.parse(text.slice(7)))], {
        stopReason: 'toolUse',
      })
    return fauxAssistantMessage(`echo ${text}`)
  }
  server.host.faux!.setResponses([route])
  try {
    await other.submit({ type: 'input', content: 'HOLD' }, context)
    await otherStarted.promise
    await ask(server, server.root.id, 'An idea.')
    const target = await branchFrom(server, { from: 1, prompt: intent })
    await ask(server, server.root.id, `NOTIFY ${JSON.stringify({ id: target, wake: false })}`)
    await runStarted.promise
    expect(await pendingNotifies(server)).toHaveLength(1)
    expect(await kinds(server, server.root.id)).not.toContain('lineage.note')
    run.resolve()
    await until(async () => (await pendingNotifies(server)).length === 0)
    const notes = (await server.root.context(context)).entries.filter(
      (entry) => entry.kind === 'lineage.note',
    )
    expect(notes).toHaveLength(1)
    expect(notes[0].data).toMatchObject({ from: target, text: 'Branch run finished' })
    const pending = await server.harness.commit(
      async (tx) =>
        (await tx.scanTasks({ conversationId: target, kind: 'lineage.notify' }, 50)).items.filter(
          (task) => task.state.status !== 'terminal',
        ),
      context,
    )
    expect(pending.map((task) => task.input)).toEqual([{ target: other.id, wake: false }])
    expect((await server.harness.snapshot(LiveDoc, other.id, context))?.run).toBeDefined()
  } finally {
    run.resolve()
    unrelated.resolve()
  }
})
