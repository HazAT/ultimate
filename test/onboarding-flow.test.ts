import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId, JsonObject } from '@earendil-works/pi-durable'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { Memory } from '../extensions/lineage/memory.ts'
import { Messages } from '../extensions/messages/api.ts'
import { Tally } from '../extensions/lineage/server.ts'
import { Starts } from '../extensions/onboarding/server.ts'
import { context } from '../server/harness.ts'
import { fauxServer, post, removeTemp, temp, until } from './helpers.ts'

const text = (content: unknown) =>
  typeof content === 'string'
    ? content
    : (content as { type: string; text?: string }[]).map((part) => part.text ?? '').join('')
const call = (name: string, args: JsonObject) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' })

/**
 * @ultimate's side of onboarding, scripted as the instructions ask: one setup card per choice, then read the README,
 * write the first memories, ask what to do first, and branch the answer. Any other request gets a plain answer.
 */
function onboarding(project: string): FauxResponseFactory {
  return (transcript) => {
    const messages = transcript.messages
    const last = messages.findLast((message) => message.role !== 'system')!
    const at = messages.findIndex(
      (message) =>
        message.role === 'user' && text(message.content).startsWith('Onboarding started.'),
    )
    if (at < 0) return fauxAssistantMessage('Done.')
    const start = text(messages[at].content)
    const since = messages.slice(at)
    const chosen = since.filter(
      (message) => message.role === 'user' && text(message.content).startsWith('Setup choice ('),
    ).length
    const said = text(last.content)
    if (
      last.role === 'user' &&
      (said.startsWith('Onboarding started.') || said.startsWith('Setup choice ('))
    )
      return chosen < 3
        ? call('setup', { card: ['extensions', 'project', 'git'][chosen] })
        : call('read', { path: join(project, 'README.md') })
    if (last.role === 'toolResult' && last.toolName === 'read')
      return call('remember', {
        root: 1,
        ops: [
          {
            op: 'add',
            slug: 'project-overview',
            kind: 'fact',
            line: 'A sample project',
            body: 'Start at its README.',
          },
          {
            op: 'add',
            slug: 'user-instructions',
            kind: 'decision',
            line: 'The user’s onboarding instructions, verbatim',
            body: start.split('User instructions:\n')[1],
          },
        ],
      })
    if (last.role === 'toolResult' && last.toolName === 'remember')
      return fauxAssistantMessage('The first memories are written. What should we do first?')
    if (
      last.role === 'user' &&
      since.some((message) => message.role === 'toolResult' && message.toolName === 'remember') &&
      !said.startsWith('Reply from')
    )
      return call('branch', { root: 1, prompt: said, isolated: false })
    return fauxAssistantMessage('Waiting.')
  }
}

it('onboards once per root with facts, choices, reading, first memories and a coordinator', async () => {
  const home = await temp('ultimate-onboarding-flow-')
  const project = join(home, 'project')
  await mkdir(join(project, '.ultimate'), { recursive: true })
  await writeFile(join(project, 'README.md'), '# Sample\nA fresh project with no Git.\n')
  await writeFile(join(project, '.ultimate/settings.json'), '{}')
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome: home,
    home: join(home, 'state'),
    firstRun: true,
    localSetup: false,
  })
  const route = onboarding(project)
  const answer: FauxResponseFactory = (...args) => {
    server.host.faux!.appendResponses([answer])
    return route(...args)
  }
  server.host.faux!.setResponses([answer])
  try {
    const instructions = 'Focus on the API.\nKeep this verbatim.'
    const start = () =>
      post(server, '/api/extensions/onboarding/actions/start', {
        args: { root: 1, instructions },
      })
    const [a, b] = await Promise.all([start(), start()])
    expect(a.status).toBe(200)
    expect(b.data.result).toEqual(a.data.result)
    const id = a.data.result.id as ConversationId
    const conversation = (await server.harness.conversation(id, context))!
    const entries = async () => (await conversation.context(context)).entries
    await server.harness.waitForIdle(context)
    const starts = (await entries()).filter((entry) => entry.kind === 'onboarding.start')
    expect(starts).toHaveLength(1)
    expect(starts[0].data).toMatchObject({
      root: 1,
      instructions,
      facts: {
        project: { name: 'project', path: project },
        firstRun: true,
        projectUndecided: true,
        root: 1,
        rootEmpty: true,
        gitReason: expect.any(String),
      },
    })
    expect(JSON.stringify(starts[0].model)).toContain('Keep this verbatim.')
    expect(await server.harness.snapshot(Starts, ROOT_CONVERSATION_ID, context)).toMatchObject({
      roots: { '1': id },
    })
    for (const card of ['extensions', 'project', 'git']) {
      expect(JSON.stringify(await entries())).toContain(`"card":"${card}"`)
      const choice = await post(server, '/api/extensions/onboarding/actions/choose', {
        args: {
          card,
          toolCallId: `onboarding-${card}`,
          ...(card === 'extensions'
            ? { extensions: { plan: true } }
            : card === 'project'
              ? { local: false }
              : { initialize: false }),
        },
        conversationId: id,
      })
      expect(choice.status).toBe(200)
      await server.harness.waitForIdle(context)
    }
    const completed = JSON.stringify(await entries())
    expect(completed).toContain('README.md')
    expect(completed).toContain('What should we do first?')
    // The first memories land in the still-empty root, the user's instructions verbatim among them.
    const memories = (await server.harness.snapshot(Memory, ROOT_CONVERSATION_ID, context))!
      .memories
    expect(Object.keys(memories).toSorted()).toEqual(['project-overview', 'user-instructions'])
    expect(memories['user-instructions'].body).toBe(instructions)
    expect((await server.root.context(context)).entries).toEqual([])
    expect((await start()).data.result).toEqual({ id })
    await (await server.harness.conversation(id, context))!.submit(
      { type: 'input', content: 'Explore a first feature' },
      context,
    )
    await server.harness.waitForIdle(context)
    await until(async () => {
      const log = await server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context)
      return (
        log?.messages.some(
          (message) =>
            message.from === id &&
            message.text === 'Explore a first feature' &&
            typeof message.to === 'number',
        ) ?? false
      )
    })
    // The first branch makes the root a tally and starts from the memory brief.
    const branch = (await server.harness.snapshot(
      Messages,
      ROOT_CONVERSATION_ID,
      context,
    ))!.messages.find(
      (message) => message.from === id && message.text === 'Explore a first feature',
    )!.to as ConversationId
    expect(
      (await server.harness.snapshot(Tally, ROOT_CONVERSATION_ID, context))?.since,
    ).toBeDefined()
    const brief = (
      await (await server.harness.conversation(branch, context))!.context(context)
    ).messages.find((message) => message.role === 'user')
    expect(JSON.stringify(brief)).toContain('<project_memory root=\\"#1\\">')
    expect(JSON.stringify(brief)).toContain('user-instructions')
  } finally {
    await server.close()
    await removeTemp(home)
  }
})
