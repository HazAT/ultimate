import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
// First: helpers mocks the faux provider's token pacing, which must apply before the server modules load.
import { eventHost, idleNeed, until, temp, removeTemp } from './helpers.ts'
import { awaitWithContext } from '@earendil-works/chord/context'
import { projectSettings } from '../server/project-setup.ts'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import {
  AssistantEntry,
  configure,
  defineExtension,
  defineTool,
  InboxDoc,
  LiveDoc,
} from '@earendil-works/pi-durable'
import type { ConversationId, Extension, Task, ToolRegistration } from '@earendil-works/pi-durable'
import type { Context, JsonValue } from '@earendil-works/chord'
import { obj } from '@earendil-works/pi-schema'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it } from 'vitest'
import { context, prepareHarness } from '../server/harness.ts'
import { emit } from '../server/events.ts'
import type { OpenHost } from '../server/harness.ts'
import subagents, { actions } from '../extensions/subagents/server.ts'
import watchdog from '../extensions/watchdog/server.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { Runs, Started, Subagents } from '../extensions/subagents/api.ts'
import type { ActionContext } from '../server/actions.ts'
import codemode from '../extensions/codemode/server.ts'
import { Metadata } from '../server/metadata.ts'
import { UiState } from '../server/ui-state.ts'
import { discoverAgents, parseDefinition, serializeDefinition } from '../lib/agents.ts'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'

const directories: string[] = []
const hosts: OpenHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  for (const path of directories.splice(0)) await removeTemp(path)
})
const definition = (body = 'Original instructions') =>
  `---\nname: scout\ndescription: Search\ntools: [read, bash]\n---\n${body}\n`
async function directory() {
  const path = await temp('ultimate-subagents-')
  directories.push(path)
  return path
}
async function fixture(
  extension?: Extension,
  observe?: (transcript: Parameters<FauxResponseFactory>[0]) => void,
  reportGate?: { promise: Promise<void>; entered: boolean; phase?: string },
  respond?: (
    transcript: Parameters<FauxResponseFactory>[0],
  ) => ReturnType<FauxResponseFactory> | undefined,
  watch = false,
) {
  const ultimateRoot = await directory()
  const userHome = await directory()
  await mkdir(join(ultimateRoot, 'agents'))
  await writeFile(
    join(ultimateRoot, 'agents/scout.md'),
    extension ? definition().replace('tools: [read, bash]\n', '') : definition(),
  )
  const errors: string[] = []
  const prepared = await prepareHarness({
    report: (notice) => {
      if (notice.level === 'error') errors.push(notice.message)
    },
    ultimateRoot,
    userHome,
    home: join(ultimateRoot, 'home'),
    faux: fauxProvider(),
  })
  prepared.registry.install(CodingTools)
  if (extension) prepared.registry.install(extension)
  let opened: OpenHost | undefined
  const onOpen: (() => Promise<void>)[] = []
  const onClose: (() => Promise<void>)[] = []
  const backend = subagents({
    projectSettings: () => projectSettings(prepared.projectRoot, prepared.userHome),
    ...prepared,
    harness: () => opened!.harness,
    metadata: Metadata,
    implement: () => {},
    need: idleNeed,
    resource: (_key, create) => create(),
    extensions: () => [],
    notice: () => {},
    onOpen: (callback) => {
      onOpen.push(callback)
    },
    onClose: (callback) => {
      onClose.push(callback)
    },
    emit,
  })
  prepared.registry.install(
    reportGate
      ? {
          ...backend,
          tasks: backend.tasks!.map((task) => {
            if (task.definition.name !== 'ultimate.subagent-reporter') return task
            const reporter = task as unknown as Task<
              JsonValue,
              { phase: string },
              JsonValue,
              object
            >
            const phase = reportGate.phase ?? 'report'
            return {
              definition: {
                ...reporter.definition,
                phases: {
                  ...reporter.definition.phases,
                  [phase]: async (
                    ...args: Parameters<typeof reporter.definition.phases.report>
                  ) => {
                    reportGate.entered = true
                    await awaitWithContext(reportGate.promise, args[2])
                    await reporter.definition.phases[phase](...args)
                  },
                },
              },
            }
          }),
        }
      : backend,
  )
  if (watch)
    prepared.registry.install(
      watchdog({
        ...prepared,
        harness: () => opened!.harness,
        metadata: Metadata,
        implement: () => {},
        need: idleNeed,
        notice: (message: string) => errors.push(message),
        onOpen: (callback: () => Promise<void>) => {
          onOpen.push(callback)
        },
        onClose: (callback: () => Promise<void>) => {
          onClose.push(callback)
        },
        onRelease: () => {},
      } as unknown as ExtensionHost),
    )
  prepared.registry.install(
    codemode({
      ...prepared,
      access: { allow: () => () => {} },
      notice: () => {},
      implement: () => {},
      need: () => {
        throw new Error('Not used')
      },
      want: () => undefined,
      catalogue: () => ({ apis: [], missing: [], cycles: [] }),
      trace: {
        query: () => [],
        page: () => ({ rows: [], last: 0 }),
        tree: () => [],
        polls: () => [],
      },
      resource: (_key, create) => create(),
      onOpen: () => {},
      onRelease: () => {},
      onClose: () => {},
      onLoadError: () => {},
      harness: () => {
        throw new Error('Not used')
      },
      system: () => {
        throw new Error('Not used')
      },
      conversations: () => [],
      emit: () => {
        throw new Error('Not used')
      },
      react: () => {},
      eventLog: { recent: async () => [], reactors: async () => [] },
      projects: async () => [],
      extensions: () => [],
      invoke: async () => {
        throw new Error('Not used')
      },
      reloadExtensions: async () => {},
      projectSetup: async () => ({ config: false, decision: null }),
      projectSettings: async () => ({}),
      projectExtensions: async () => [],
      setProjectDecision: async () => {},
      doc: () => undefined,
      metadata: Metadata,
    }),
  )
  const route: FauxResponseFactory = (transcript) => {
    observe?.(transcript)
    prepared.faux!.appendResponses([route])
    if (respond) {
      const response = respond(transcript)
      if (response) return response
    }
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    const text =
      typeof last.content === 'string'
        ? last.content
        : last.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
    if (last.role === 'user' && text.startsWith('CODE '))
      return fauxAssistantMessage([fauxToolCall('codemode', { code: text.slice(5) })], {
        stopReason: 'toolUse',
      })
    if (last.role === 'user' && text === 'HOLD')
      return fauxAssistantMessage([fauxToolCall('hold', {})], { stopReason: 'toolUse' })
    if (last.role === 'user' && text.startsWith('CALL '))
      return fauxAssistantMessage([fauxToolCall('subagent', JSON.parse(text.slice(5)))], {
        stopReason: 'toolUse',
      })
    if (last.role === 'user' && text.startsWith('[subagent'))
      return fauxAssistantMessage([fauxText('Report received')])
    return fauxAssistantMessage([
      fauxText(last.role === 'toolResult' ? `Result: ${text}` : `Child: ${text}`),
    ])
  }
  prepared.faux!.setResponses([route])
  const open = async () => {
    opened = await prepared.open()
    const close = opened.close.bind(opened)
    opened.close = async () => {
      for (const callback of onClose) await callback()
      await close()
    }
    for (const callback of onOpen) await callback()
    hosts.push(opened)
    return opened
  }
  await open()
  return {
    prepared,
    opened: opened!,
    ultimateRoot,
    userHome,
    errors,
    reopen: open,
  }
}
async function call(opened: OpenHost, args: Record<string, unknown>) {
  await (
    await opened.root.submit({ type: 'input', content: `CALL ${JSON.stringify(args)}` }, context)
  ).wait(context)
  const view = await opened.root.context(context)
  const tool = view.entries.filter((entry) => entry.kind === 'pi.tool-result').at(-1)!
  const result = tool.model?.[0]
  const text =
    result?.role === 'toolResult'
      ? result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
      : ''
  return { tool, text }
}
it('runs root -> forked review lead -> parallel leaves -> lead -> root with scoped ownership', async () => {
  const range = `${'a'.repeat(40)}..${'b'.repeat(40)}`
  const task = `Review ${range}; acceptance: read-only review`
  const seen: Parameters<FauxResponseFactory>[0][] = []
  const f = await fixture(
    undefined,
    (transcript) => seen.push(transcript),
    undefined,
    (transcript) => {
      const last = transcript.messages.findLast((message) => message.role !== 'system')!
      if (last.role === 'user' && last.content === 'TEAM')
        return fauxAssistantMessage(
          ['astra', 'sol'].map((agent) =>
            fauxToolCall('subagent', {
              action: 'start',
              agent,
              task,
            }),
          ),
          { stopReason: 'toolUse' },
        )
      if (last.role === 'user' && last.content === task)
        return fauxAssistantMessage(`APPROVED ${range}`)
      if (
        (last.role === 'toolResult' ||
          (last.role === 'user' &&
            typeof last.content === 'string' &&
            last.content.startsWith('[subagent'))) &&
        transcript.messages.some((message) => message.role === 'user' && message.content === 'TEAM')
      ) {
        const results = transcript.messages.filter((message) => message.role === 'toolResult')
        const yielded = results.findLast((message) =>
          JSON.stringify(message.content).includes('Wait yielded'),
        )
        const completed = results.filter((message) =>
          JSON.stringify(message.content).includes(`APPROVED ${range}`),
        )
        if (completed.length < 2 && yielded?.role === 'toolResult')
          return fauxAssistantMessage(
            [
              fauxToolCall('subagent', {
                action: 'wait',
                id: (yielded.details as { conversationId: number }).conversationId,
              }),
            ],
            { stopReason: 'toolUse' },
          )
        return fauxAssistantMessage(
          `Synthesis ${completed.map((message) => JSON.stringify(message.content)).join(' ')}`,
        )
      }
      return undefined
    },
  )
  for (const name of ['lead', 'astra', 'sol', 'omitted', 'invalid'])
    await writeFile(
      join(f.ultimateRoot, `agents/${name}.md`),
      `---\nname: ${name}\ndescription: ${name}\n${name === 'omitted' ? '' : `tools: [read, bash${name === 'lead' ? ', subagent' : name === 'invalid' ? ', missing' : ''}]\n`}---\nAssigned ${name} role\n`,
    )
  await call(f.opened, { action: 'start', agent: 'scout', task: 'prior child' })
  const result = await call(f.opened, { action: 'start', agent: 'lead', task: 'TEAM', fork: true })
  expect(result.text).toContain('Synthesis')
  expect(result.text).toContain('faux/faux-1')
  expect(result.text).toContain(range)
  const rootChildren = await children(f.opened)
  expect(rootChildren.map((child) => child.agent)).toEqual(['scout', 'lead'])
  const leadId = rootChildren[1].conversationId
  const lead = (await f.opened.harness.conversation(leadId, context))!
  const leadAgent = await lead.agent(context)
  expect(result.text.match(/APPROVED/g)?.length).toBe(2)
  expect(leadAgent.tools.map((tool) => tool.name)).toEqual(['read', 'bash', 'subagent'])
  expect(leadAgent.extensions.some((extension) => extension.name === 'subagents')).toBe(true)
  const leadIndex = (await f.opened.harness.snapshot(Subagents, leadId, context))!
  expect(
    Object.values(leadIndex.agents)
      .map((child) => child.agent)
      .toSorted(),
  ).toEqual(['astra', 'sol'])
  expect(Object.keys(leadIndex.actions)).toHaveLength(2)
  for (const child of Object.values(leadIndex.agents)) {
    const leaf = (await f.opened.harness.conversation(child.conversationId, context))!
    const agent = await leaf.agent(context)
    expect(agent.tools.map((tool) => tool.name)).toEqual(['read', 'bash'])
    expect(agent.extensions.some((extension) => extension.name === 'subagents')).toBe(false)
    await (
      await leaf.submit(
        {
          type: 'input',
          content: `CALL ${JSON.stringify({ action: 'start', agent: 'scout', task: 'forbidden' })}`,
        },
        context,
      )
    ).wait(context)
    expect(await f.opened.harness.snapshot(Subagents, leaf.id, context)).toBeUndefined()
    const denial = await call(f.opened, { action: 'wait', id: leaf.id })
    expect(denial.text).toContain('id must identify a child')
  }
  const leadTranscript = seen.find((transcript) =>
    transcript.messages.some((message) => message.role === 'user' && message.content === 'TEAM'),
  )!
  expect(JSON.stringify(leadTranscript.messages)).toContain('Available definitions')
  const invalid = await call(f.opened, { action: 'start', agent: 'invalid', task: 'reject' })
  expect(invalid.text).toContain('subset of parent tools')
  await call(f.opened, { action: 'start', agent: 'omitted', task: 'no delegation' })
  const omittedId = (await children(f.opened)).at(-1)!.conversationId
  const omitted = (await f.opened.harness.conversation(omittedId, context))!
  expect((await omitted.agent(context)).tools.some((tool) => tool.name === 'subagent')).toBe(false)
  expect(
    (await omitted.agent(context)).extensions.some((extension) => extension.name === 'subagents'),
  ).toBe(false)
  await (
    await omitted.submit(
      {
        type: 'input',
        content: `CALL ${JSON.stringify({ action: 'start', agent: 'scout', task: 'forbidden' })}`,
      },
      context,
    )
  ).wait(context)
  expect(await f.opened.harness.snapshot(Subagents, omittedId, context)).toBeUndefined()
})

it('names the definitions when start omits agent, for every argument shape seen in the trace', async () => {
  const f = await fixture()
  for (const shape of [
    {},
    { background: true },
    { background: true, isolate: 'none' },
    { background: true, fork: true, isolate: 'worktree' },
  ]) {
    const result = await call(f.opened, { action: 'start', task: 'Review', ...shape })
    expect(result.text).toContain('Unknown agent: undefined. Pass agent: one of scout')
  }
  expect(await children(f.opened)).toHaveLength(0)
})

it('makes an agent on the fly from the call, read-only without a worktree, and refuses a model without a login', async () => {
  const f = await fixture()
  const noLogin = await call(f.opened, {
    action: 'start',
    label: 'dead-code scan',
    family: 'review',
    tools: ['read', 'bash'],
    task: 'Scan',
  })
  expect(noLogin.text).toContain('No login for openai-codex/gpt-6-astra (family review)')
  expect(await children(f.opened)).toHaveLength(0)
  await call(f.opened, {
    action: 'start',
    label: 'dead-code scan',
    model: 'faux/faux-1',
    thinking: 'low',
    tools: ['read', 'bash'],
    instructions: 'List unused exports.',
    task: 'Scan',
  })
  const [child] = await children(f.opened)
  expect(child.agent).toBe('dead-code scan')
  const agent = await (await f.opened.harness.conversation(child.conversationId, context))!.agent(
    context,
  )
  expect(agent.tools.map((tool) => tool.name).toSorted()).toEqual(['bash', 'read'])
  expect(agent.model).toEqual({ provider: 'faux', modelId: 'faux-1' })
  expect(agent.instructions).toMatch(/^You were made for one task[\s\S]*List unused exports\.$/)
  expect(agent.cwd).toBe((await f.opened.root.agent(context)).cwd)
  expect(await f.opened.harness.snapshot(Runs, f.opened.root.id, context)).toEqual({
    [child.conversationId]: { model: 'faux-1', adhoc: true },
  })
  expect(await f.opened.harness.snapshot(Metadata, child.conversationId, context)).toMatchObject({
    label: 'dead-code scan',
  })
})

it('routes asynchronous leaf reports only to their lead, not the root', async () => {
  const f = await fixture()
  await writeFile(
    join(f.ultimateRoot, 'agents/lead.md'),
    '---\nname: lead\ndescription: Lead\ntools: [read, bash, subagent]\n---\nLead role\n',
  )
  await call(f.opened, { action: 'start', agent: 'lead', task: 'Ready' })
  const leadId = (await children(f.opened))[0].conversationId
  await call(f.opened, {
    action: 'message',
    id: leadId,
    text: `CALL ${JSON.stringify({ action: 'start', agent: 'scout', task: 'Leaf report', background: true })}`,
  })
  const lead = (await f.opened.harness.conversation(leadId, context))!
  await until(async () => {
    const view = await lead.context(context)
    const delivered = view.entries.some((entry) => entry.kind === 'subagents.report')
    return delivered
  })
  await lead.waitForIdle(context)
  const view = await lead.context(context)
  const report = view.entries.find((entry) => entry.kind === 'subagents.report')!
  expect(report).toBeDefined()
  const leafId = Object.values(
    (await f.opened.harness.snapshot(Subagents, leadId, context))!.agents,
  )[0].conversationId
  expect(report.data).toMatchObject({
    sender: leafId,
    kind: 'report',
  })
  expect(await reports(f.opened)).toHaveLength(0)
  expect((await children(f.opened)).map((child) => child.conversationId)).toEqual([leadId])
})

it('exposes stored returned identity in async reports, foreground messages and waits', async () => {
  const f = await fixture(undefined, undefined, undefined, (transcript) => {
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    if (last.role === 'user' && last.content === 'identity')
      return fauxAssistantMessage('Original report')
    return undefined
  })
  await call(f.opened, { action: 'start', agent: 'scout', task: 'identity', background: true })
  await until(async () => (await reports(f.opened)).length === 1)
  expect(JSON.stringify(await reports(f.opened))).toContain('Returned model: faux/faux-1')
  const id = (await children(f.opened))[0].conversationId
  const child = (await f.opened.harness.conversation(id, context))!
  expect((await child.agent(context)).model).toEqual({ provider: 'faux', modelId: 'faux-1' })
  expect((await call(f.opened, { action: 'wait', id })).text).toContain(
    'Returned model: faux/faux-1\nOriginal report',
  )
  await call(f.opened, { action: 'start', agent: 'scout', task: 'identity' })
  const foregroundId = (await children(f.opened)).at(-1)!.conversationId
  expect(
    (await call(f.opened, { action: 'message', id: foregroundId, text: 'identity' })).text,
  ).toContain('Returned model: faux/faux-1\nOriginal report')
})

it('wait uses stored answer identity even when it differs from the configured profile', async () => {
  const f = await fixture()
  await call(f.opened, { action: 'start', agent: 'scout', task: 'Configured profile' })
  const id = (await children(f.opened))[0].conversationId
  // Faux normalizes response identities, so seed the stored answer to exercise a provider mismatch.
  const answer = await f.opened.harness.commit(
    (tx) =>
      tx.appendEntry(AssistantEntry, id, {
        model: [
          {
            ...fauxAssistantMessage('Provider report'),
            provider: 'actual',
            model: 'different-model',
          },
        ],
      }),
    context,
  )
  const result = await call(f.opened, { action: 'wait', id })
  expect(result.text).toBe('Returned model: actual/different-model\nProvider report')
  expect(result.tool.model?.[0]).toMatchObject({ details: { answerId: answer.id } })
  expect((await (await f.opened.harness.conversation(id, context))!.agent(context)).model).toEqual({
    provider: 'faux',
    modelId: 'faux-1',
  })
})

it('attributes durable instructions and reports across reopen and forks, never human lookalikes', async () => {
  const f = await fixture()
  await call(f.opened, {
    action: 'start',
    agent: 'scout',
    task: '**Inspect**\n\n- [x] checked',
    background: true,
  })
  await until(async () => (await reports(f.opened)).length > 0)
  const report = (await reports(f.opened))[0]
  const [child] = await children(f.opened)
  const conversation = (await f.opened.harness.conversation(child.conversationId, context))!
  const childView = await conversation.context(context)
  const instruction = childView.entries.find((entry) => entry.kind === 'subagents.instruction')!
  expect(instruction.data).toMatchObject({
    sender: f.opened.root.id,
    kind: 'instruction',
    body: '**Inspect**\n\n- [x] checked',
    agent: 'scout',
  })
  expect(report.data).toMatchObject({
    sender: child.conversationId,
    kind: 'report',
    failed: false,
    agent: 'scout',
  })
  expect((report.data as { entry: number }).entry).toBeTypeOf('number')
  const human = await f.opened.root.submit(
    { type: 'input', content: `[subagent ${child.conversationId} (scout) answered] **human**` },
    context,
  )
  const humanRecord = await human.wait(context)
  expect((await f.opened.harness.commit((tx) => tx.entry(humanRecord.entry!), context))?.kind).toBe(
    'pi.user',
  )
  const fork = await f.opened.root.fork(report.id, { ownership: { kind: 'ownerless' } }, context)
  await f.opened.close()
  hosts.splice(hosts.indexOf(f.opened), 1)
  const reopened = await f.reopen()
  const forkView = await (await reopened.harness.conversation(fork.id, context))!.context(context)
  expect(forkView.entries.find((entry) => entry.id === report.id)?.data).toEqual(report.data)
})

async function children(opened: OpenHost) {
  return Object.values(
    (await opened.harness.snapshot(Subagents, opened.root.id, context))?.agents ?? {},
  )
}
async function reports(opened: OpenHost) {
  const view = await opened.root.context(context)
  const entries = view.entries.filter((entry) => entry.kind === 'subagents.report')
  return entries
}

describe('provider error recovery', () => {
  it.each([false, true])(
    'delivers a successful watchdog retry of a finished child’s one-way message once (offline: %s)',
    async (offlineAnswer) => {
      const f = await fixture(undefined, undefined, undefined, (transcript) =>
        transcript.messages.at(-1)?.role === 'user' &&
        transcript.messages.at(-1)?.content === 'one-way failure'
          ? fauxAssistantMessage('', {
              stopReason: 'error',
              errorMessage: 'Our servers are currently overloaded. Please try again later.',
            })
          : undefined,
      )
      await call(f.opened, { action: 'start', agent: 'scout', task: 'initial answer' })
      const [child] = await children(f.opened)
      const handle = (await f.opened.harness.conversation(child.conversationId, context))!
      await (
        await handle.submit(
          {
            type: 'input',
            content: 'one-way failure',
            entry: {
              kind: 'board.message',
              data: { from: f.opened.root.id, reply: false },
            },
          },
          context,
        )
      ).wait(context)
      expect(
        Object.values(
          (await f.opened.harness.snapshot(Subagents, f.opened.root.id, context))!.actions,
        ).map((action) => action.status),
      ).toEqual(['done'])
      const before = (await reports(f.opened)).length
      let opened = f.opened
      if (offlineAnswer) {
        await opened.close()
        hosts.splice(hosts.indexOf(opened), 1)
        opened = await f.prepared.open()
        hosts.push(opened)
      }
      await (
        await (await opened.harness.conversation(child.conversationId, context))!.submit(
          {
            type: 'input',
            content: 'recovered one-way answer',
            requestId: 'watchdog-retry:one-way',
          },
          context,
        )
      ).wait(context)
      if (!offlineAnswer) {
        await until(async () => (await reports(opened)).length === before + 1)
        await opened.harness.waitForIdle(context)
      }
      await opened.close()
      hosts.splice(hosts.indexOf(opened), 1)
      const resumed = await f.reopen()
      await until(async () => (await reports(resumed)).length === before + 1)
      await resumed.harness.waitForIdle(context)
      expect(
        (await reports(resumed)).filter((entry) =>
          JSON.stringify(entry.model).includes('recovered one-way answer'),
        ),
      ).toHaveLength(1)
      expect((await children(resumed))[0].reported).toHaveLength(2)
      await resumed.close()
      hosts.splice(hosts.indexOf(resumed), 1)
      const again = await f.reopen()
      await again.harness.waitForIdle(context)
      expect(await reports(again)).toHaveLength(before + 1)
    },
  )
  it('sends one watchdog card to the actual parent without a reporter failure, and gives the action up', async () => {
    const f = await fixture(
      undefined,
      undefined,
      undefined,
      (transcript) =>
        transcript.messages.at(-1)?.role === 'user' &&
        transcript.messages.at(-1)?.content === 'fail'
          ? fauxAssistantMessage('', {
              stopReason: 'error',
              errorMessage: 'invalid model configuration',
            })
          : undefined,
      true,
    )
    await call(f.opened, { action: 'start', agent: 'scout', task: 'fail', background: true })
    const failures = async () =>
      (await f.opened.root.context(context)).entries.filter(
        (entry) => entry.kind === 'watchdog.failure',
      )
    await until(async () => (await failures()).length === 1)
    await f.opened.harness.waitForIdle(context)
    expect((await failures())[0].data).toMatchObject({
      conversation: (await children(f.opened))[0].conversationId,
      error: 'invalid model configuration',
      retried: false,
    })
    // Reported, not retried: the action is final, not left `failed` for a retry that never comes.
    expect(
      Object.values(
        (await f.opened.harness.snapshot(Subagents, f.opened.root.id, context))!.actions,
      ).map((action) => action.status),
    ).toEqual(['given-up'])
    expect(await reports(f.opened)).toHaveLength(0)
    expect(f.errors).toEqual([])
  })
  it.each([false, true])(
    'leaves provider failures to watchdog and delivers its retry answer once (offline: %s)',
    async (offlineAnswer) => {
      const held = { ...gate(), entered: false, phase: 'deliver' }
      const f = await fixture(undefined, undefined, held, (transcript) => {
        const last = transcript.messages.at(-1)!
        if (last.role === 'user' && last.content === 'provider failure')
          return fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'provider failed' })
        return undefined
      })
      await call(f.opened, {
        action: 'start',
        agent: 'scout',
        task: 'provider failure',
        background: true,
      })
      await until(async () => held.entered)
      const [child] = await children(f.opened)
      await f.opened.harness.commit(
        (tx) =>
          configure(tx, child.conversationId, {
            model: { provider: 'missing', modelId: 'missing' },
          }),
        context,
      )
      held.release()
      await f.opened.harness.waitForIdle(context)
      await until(async () =>
        Object.values(
          (await f.opened.harness.snapshot(Subagents, f.opened.root.id, context))!.actions,
        ).every((action) => action.status === 'failed'),
      )
      expect(await reports(f.opened)).toHaveLength(0)
      await f.opened.harness.commit(
        (tx) =>
          configure(tx, child.conversationId, { model: { provider: 'faux', modelId: 'faux-1' } }),
        context,
      )
      const handle = (await f.opened.harness.conversation(child.conversationId, context))!
      if (!offlineAnswer) {
        await (
          await handle.submit(
            { type: 'input', content: 'manual continuation', requestId: 'watchdog-retry:fixture' },
            context,
          )
        ).wait(context)
        await until(async () => (await reports(f.opened)).length === 1)
        await f.opened.harness.waitForIdle(context)
      }
      // An unobserved completion exercises the startup scan instead of live delivery.
      await f.opened.close()
      hosts.splice(hosts.indexOf(f.opened), 1)
      const offline = await f.prepared.open()
      hosts.push(offline)
      if (offlineAnswer)
        await (
          await (await offline.harness.conversation(child.conversationId, context))!.submit(
            { type: 'input', content: 'manual continuation', requestId: 'watchdog-retry:fixture' },
            context,
          )
        ).wait(context)
      await offline.close()
      hosts.splice(hosts.indexOf(offline), 1)
      const resumed = await f.reopen()
      await until(async () => (await reports(resumed)).length === 1)
      await resumed.harness.waitForIdle(context)
      const delivered = await reports(resumed)
      expect(delivered).toHaveLength(1)
      expect(delivered[0].model![0].content).toContain(
        `[subagent ${child.conversationId} (scout) answered]`,
      )
      expect(delivered[0].model![0].content).toContain('manual continuation')
      expect((await children(resumed))[0].reported).toHaveLength(1)
      expect(delivered[0].data).toMatchObject({
        sender: child.conversationId,
        kind: 'report',
        entry: (await children(resumed))[0].reported[0],
      })
      await resumed.close()
      hosts.splice(hosts.indexOf(resumed), 1)
      const again = await f.reopen()
      await again.harness.waitForIdle(context)
      expect(await reports(again)).toHaveLength(1)
      await call(again, { action: 'message', id: handle.id, text: 'reporter continuation' })
      await again.harness.waitForIdle(context)
      expect((await children(again))[0].reported).toHaveLength(2)
      expect(
        (await reports(again)).filter((entry) =>
          JSON.stringify(entry.model).includes('reporter continuation'),
        ),
      ).toHaveLength(1)
    },
  )

  it('returns provider failure to foreground start without sending a parent failure report', async () => {
    const f = await fixture(undefined, undefined, undefined, (transcript) =>
      transcript.messages.at(-1)?.role === 'user' && transcript.messages.at(-1)?.content === 'fail'
        ? fauxAssistantMessage('', {
            stopReason: 'error',
            errorMessage: 'invalid model configuration',
          })
        : undefined,
    )
    const result = await call(f.opened, { action: 'start', agent: 'scout', task: 'fail' })
    expect(result.text).toContain('failed')
    const [child] = await children(f.opened)
    const waited = await call(f.opened, { action: 'wait', id: child.conversationId })
    expect(waited.text).toContain('ended its turn without an answer (error)')
    await f.opened.harness.waitForIdle(context)
    expect(await reports(f.opened)).toHaveLength(0)
  })
})

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
async function gatedFixture(reportGate?: { promise: Promise<void>; entered: boolean }) {
  const childGate = gate()
  const parentGate = gate()
  const holding = new Set<number>()
  const requests: Parameters<FauxResponseFactory>[0][] = []
  const f = await fixture(
    defineExtension({
      name: 'hold',
      tools: [
        defineTool({
          name: 'hold',
          description: 'Deterministic completion gate',
          parameters: obj({}),
          replay: 'safe',
          execute: async (_args, api, toolContext) => {
            holding.add(api.conversationId)
            await awaitWithContext(
              api.conversationId === 1 ? parentGate.promise : childGate.promise,
              toolContext,
            )
            return { output: [{ type: 'text', text: 'released' }] }
          },
        }),
      ],
    }),
    (request) => {
      requests.push(request)
    },
    reportGate,
  )
  return { ...f, childGate, parentGate, holding, requests }
}
async function startCall(opened: OpenHost, args: Record<string, unknown>) {
  return opened.root.submit({ type: 'input', content: `CALL ${JSON.stringify(args)}` }, context)
}
async function latestResult(opened: OpenHost) {
  const view = await opened.root.context(context)
  return view.entries.filter((entry) => entry.kind === 'pi.tool-result').at(-1)?.model?.[0]
}

it('attributes real queued instructions and reports by submission identity and drops cancellations', async () => {
  const f = await gatedFixture()
  await call(f.opened, { action: 'start', agent: 'scout', task: 'HOLD', background: true })
  const [child] = await children(f.opened)
  await until(async () => f.holding.has(child.conversationId))
  await call(f.opened, { action: 'message', id: child.conversationId, text: 'queued instruction' })
  const childHandle = (await f.opened.harness.conversation(child.conversationId, context))!
  await until(
    async () =>
      (await f.opened.harness.snapshot(InboxDoc, child.conversationId, context))!.items.length > 0,
  )
  const instruction = (await f.opened.harness.snapshot(InboxDoc, child.conversationId, context))!
    .items[0]
  expect(instruction).toMatchObject({
    mode: 'steer',
    entry: {
      kind: 'subagents.instruction',
      data: { sender: 1, kind: 'instruction', body: 'queued instruction' },
    },
  })
  const human = await childHandle.submit(
    { type: 'input', content: 'queued instruction', whenBusy: 'followUp' },
    context,
  )
  expect(
    (await f.opened.harness.snapshot(InboxDoc, child.conversationId, context))!.items.find(
      (item) => item.id === human.id,
    ),
  ).not.toHaveProperty('entry')
  await (await f.opened.harness.submission(instruction.id, context))!.abort(context)
  expect(
    (await f.opened.harness.snapshot(InboxDoc, child.conversationId, context))!.items.some(
      (item) => item.id === instruction.id,
    ),
  ).toBe(false)
  await human.abort(context)
  await f.opened.root.submit({ type: 'input', content: 'HOLD' }, context)
  await until(async () => f.holding.has(1))
  f.childGate.release()
  await until(
    async () =>
      (await f.opened.harness.snapshot(InboxDoc, f.opened.root.id, context))!.items.length > 0,
  )
  const report = (await f.opened.harness.snapshot(InboxDoc, f.opened.root.id, context))!.items[0]
  expect(report.entry).toMatchObject({
    kind: 'subagents.report',
    data: { sender: child.conversationId, kind: 'report', failed: false },
  })
  await (await f.opened.harness.submission(report.id, context))!.abort(context)
  expect(
    (await f.opened.harness.snapshot(InboxDoc, f.opened.root.id, context))!.items.some(
      (item) => item.id === report.id,
    ),
  ).toBe(false)
  f.parentGate.release()
})

describe('turns without an answer', () => {
  it('reports an empty final turn as a failure, not an answer, and wait says so too', async () => {
    const f = await fixture(undefined, undefined, undefined, (transcript) => {
      const last = transcript.messages.findLast((message) => message.role !== 'system')!
      return last.role === 'user' && last.content === 'EMPTY'
        ? fauxAssistantMessage([fauxThinking('')])
        : undefined
    })
    await call(f.opened, { action: 'start', agent: 'scout', task: 'EMPTY', background: true })
    const [child] = await children(f.opened)
    await until(async () => (await reports(f.opened)).length === 1)
    expect((await reports(f.opened))[0].model?.[0]).toMatchObject({
      content: `[subagent ${child.conversationId} failed: ended its turn without an answer]`,
    })
    expect((await reports(f.opened))[0].data).toMatchObject({
      failed: true,
      body: 'Failed: ended its turn without an answer',
    })
    expect((await call(f.opened, { action: 'wait', id: child.conversationId })).text).toBe(
      `Subagent ${child.conversationId} ended its turn without an answer. Message it to continue.`,
    )
    const foreground = await call(f.opened, { action: 'start', agent: 'scout', task: 'EMPTY' })
    const other = (await children(f.opened)).at(-1)!.conversationId
    expect(foreground.text).toBe(
      `Subagent ${other} ended its turn without an answer. Message it to continue.`,
    )
  })
  it('wakes an idle parent with the answer to its one-way message, never to a reply-expecting one', async () => {
    const f = await fixture()
    await call(f.opened, { action: 'start', agent: 'scout', task: 'Ready', background: true })
    await until(async () => (await reports(f.opened)).length === 1)
    await f.opened.harness.waitForIdle(context)
    const [child] = await children(f.opened)
    const handle = (await f.opened.harness.conversation(child.conversationId, context))!
    // What message delivery submits: a two-way message gets a reply, a one-way one nothing.
    const deliver = async (id: number, reply: boolean, content: string) =>
      (
        await handle.submit(
          {
            type: 'input',
            content,
            entry: {
              kind: 'board.message',
              data: { id, from: f.opened.root.id, text: content, reply, delivery: 'followUp' },
            },
          },
          context,
        )
      ).wait(context)
    await deliver(1, true, 'Question')
    await f.opened.harness.waitForIdle(context)
    expect(await reports(f.opened)).toHaveLength(1)
    await deliver(2, false, 'Rebase and report')
    await until(async () => (await reports(f.opened)).length === 2)
    expect((await reports(f.opened))[1].model?.[0]).toMatchObject({
      content: `[subagent ${child.conversationId} (scout) answered] Returned model: faux/faux-1\nChild: Rebase and report`,
    })
    // The report started a parent run, which answered it.
    await f.opened.harness.waitForIdle(context)
    const view = await f.opened.root.context(context)
    const last = view.entries.at(-1)!
    expect(last.model?.[0]).toMatchObject({ role: 'assistant' })
    expect(JSON.stringify(last.model)).toContain('Report received')
  })
  it('reports the answer to the parent’s reply to the child’s question once, across reopen', async () => {
    const f = await fixture()
    await call(f.opened, { action: 'start', agent: 'scout', task: 'Ready', background: true })
    await until(async () => (await reports(f.opened)).length === 1)
    await f.opened.harness.waitForIdle(context)
    const [child] = await children(f.opened)
    const handle = (await f.opened.harness.conversation(child.conversationId, context))!
    // What the Messages reply phase submits into the child after it asked a question with `message`.
    const reply = async (id: number, from: number, content: string) =>
      (
        await handle.submit(
          {
            type: 'input',
            requestId: `board-reply:${id}`,
            whenBusy: 'steer',
            content,
            entry: {
              kind: 'board.reply',
              data: { id, re: id - 1, from, text: content, failed: false },
            },
          },
          context,
        )
      ).wait(context)
    // Another conversation answering the child's question is not the parent's business.
    await reply(2, f.opened.root.id + 1000, 'Sibling reply')
    await f.opened.harness.waitForIdle(context)
    expect(await reports(f.opened)).toHaveLength(1)
    await reply(4, f.opened.root.id, 'Yes, proceed')
    await until(async () => (await reports(f.opened)).length === 2)
    expect((await reports(f.opened))[1].model?.[0]).toMatchObject({
      content: `[subagent ${child.conversationId} (scout) answered] Returned model: faux/faux-1\nChild: Yes, proceed`,
    })
    await f.opened.harness.waitForIdle(context)
    await f.opened.close()
    hosts.splice(hosts.indexOf(f.opened), 1)
    const resumed = await f.reopen()
    await resumed.harness.waitForIdle(context)
    expect(await reports(resumed)).toHaveLength(2)
  })
  it('reports a one-way message answer once while a later queued follow-up is pending', async () => {
    const f = await gatedFixture()
    await call(f.opened, { action: 'start', agent: 'scout', task: 'Ready', background: true })
    await until(async () => (await reports(f.opened)).length === 1)
    await f.opened.harness.waitForIdle(context)
    const [child] = await children(f.opened)
    const handle = (await f.opened.harness.conversation(child.conversationId, context))!
    const oneWay = await handle.submit(
      {
        type: 'input',
        content: 'HOLD',
        entry: {
          kind: 'board.message',
          data: { id: 1, from: f.opened.root.id, text: 'HOLD', reply: false, delivery: 'followUp' },
        },
      },
      context,
    )
    await until(async () => f.holding.has(child.conversationId))
    await call(f.opened, {
      action: 'message',
      id: child.conversationId,
      text: 'Later follow-up',
      steer: false,
    })
    f.childGate.release()
    const answered = await oneWay.wait(context)
    await until(async () =>
      Object.values(
        (await f.opened.harness.snapshot(Subagents, f.opened.root.id, context))!.actions,
      ).every((action) => action.status !== undefined),
    )
    await f.opened.harness.waitForIdle(context)
    // The follow-up ran after the one-way message's run: two distinct answers, each reported once.
    const answer = answered.status === 'done' ? answered.answer : undefined
    const delivered = (await reports(f.opened)).slice(1).map((entry) => entry.data) as {
      entry: number
      body: string
    }[]
    expect(delivered).toHaveLength(2)
    expect(delivered.filter((report) => report.entry === answer)).toHaveLength(1)
    expect(delivered.find((report) => report.entry !== answer)?.body).toContain(
      'Child: Later follow-up',
    )
  })
  it('delivers the answer that follows a child-side stop exactly once, across reopen', async () => {
    const f = await gatedFixture()
    await call(f.opened, { action: 'start', agent: 'scout', task: 'HOLD', background: true })
    const [child] = await children(f.opened)
    await until(async () => f.holding.has(child.conversationId))
    // The human stops the child in its own conversation, then tells it to continue.
    const handle = (await f.opened.harness.conversation(child.conversationId, context))!
    await handle.abort(context)
    await f.opened.harness.waitForIdle(context)
    expect(await reports(f.opened)).toHaveLength(0)
    expect((await call(f.opened, { action: 'wait', id: child.conversationId })).text).toMatch(
      /ended its turn without an answer/,
    )
    await (await handle.submit({ type: 'input', content: 'continue' }, context)).wait(context)
    await until(async () => (await reports(f.opened)).length === 1)
    expect((await reports(f.opened))[0].model?.[0]).toMatchObject({
      content: `[subagent ${child.conversationId} (scout) answered] Returned model: faux/faux-1\nChild: continue`,
    })
    await f.opened.harness.waitForIdle(context)
    await f.opened.close()
    hosts.splice(hosts.indexOf(f.opened), 1)
    const resumed = await f.reopen()
    await resumed.harness.waitForIdle(context)
    expect(await reports(resumed)).toHaveLength(1)
  })
})

function stopCaptureGate(f: Awaited<ReturnType<typeof gatedFixture>>) {
  const state = { ...gate(), entered: false, enabled: true }
  f.prepared.registry.install(
    defineExtension({
      name: 'stop-gate',
      wraps: [
        {
          tool: 'subagent',
          wrap: (tool: ToolRegistration): ToolRegistration => ({
            ...tool,
            execute: (args, api, toolContext) =>
              tool.execute(
                args,
                {
                  ...api,
                  memo: (name: string, value: JsonValue | Context, memoContext?: Context) => {
                    const saved =
                      memoContext === undefined
                        ? api.memo(name, value as Context)
                        : api.memo(name, value as JsonValue, memoContext)
                    return saved.then(async (winner) => {
                      if (name === 'stopTarget' && state.enabled) {
                        state.entered = true
                        await awaitWithContext(state.promise, toolContext)
                      }
                      return winner
                    })
                  },
                },
                toolContext,
              ),
          }),
        },
      ],
    }),
  )
  return state
}

describe('subagents', () => {
  it.each(['start', 'message', 'wait'] as const)(
    '%s yields on steer before child completes and reports once',
    async (action) => {
      const f = await gatedFixture()
      let id: number | undefined
      if (action !== 'start') {
        await call(f.opened, {
          action: 'start',
          agent: 'scout',
          task: action === 'wait' ? 'HOLD' : 'facts',
          background: action === 'wait',
        })
        id = (await children(f.opened))[0].conversationId
      }
      const pending = await startCall(
        f.opened,
        action === 'start'
          ? { action, agent: 'scout', task: 'HOLD' }
          : { action, id, ...(action === 'message' ? { text: 'HOLD' } : {}) },
      )
      await until(async () =>
        (await children(f.opened)).some((child) => f.holding.has(child.conversationId)),
      )
      id = (await children(f.opened))[0].conversationId
      const steer = await f.opened.root.submit(
        { type: 'input', content: 'change direction', whenBusy: 'steer' },
        context,
      )
      await steer.wait(context)
      await pending.wait(context)
      expect(await latestResult(f.opened)).toMatchObject({
        details: { conversationId: id, yielded: true },
        isError: false,
      })
      expect(
        (await f.opened.harness.snapshot(LiveDoc, id as ConversationId, context))?.run,
      ).toBeDefined()
      expect(await reports(f.opened)).toHaveLength(0)
      const request = f.requests.findLast((candidate) =>
        candidate.messages.some(
          (message) => message.role === 'user' && message.content === 'change direction',
        ),
      )!
      expect(JSON.stringify(request.messages)).toContain(`Still running subagents: ${id} (scout)`)
      expect(
        request.messages.filter(
          (message) => message.role === 'user' && message.content === 'change direction',
        ),
      ).toHaveLength(1)
      f.childGate.release()
      await until(async () => (await reports(f.opened)).length === 1)
      await f.opened.harness.waitForIdle(context)
      expect(await reports(f.opened)).toHaveLength(1)
      expect((await children(f.opened))[0].reported).toHaveLength(action === 'message' ? 2 : 1)
      expect(
        f.requests
          .at(-1)
          ?.messages.findLast(
            (message) =>
              message.role === 'system' && Object.hasOwn(message.sections ?? {}, 'subagent_state'),
          ),
      ).toMatchObject({ sections: { subagent_state: null } })
      await call(f.opened, { action: 'wait', id })
      expect(await reports(f.opened)).toHaveLength(1)
    },
  )
  it('does not wake for followUp, but does wake for an already queued steer', async () => {
    const f = await gatedFixture()
    await call(f.opened, { action: 'start', agent: 'scout', task: 'HOLD', background: true })
    const [child] = await children(f.opened)
    const pending = await startCall(f.opened, { action: 'wait', id: child.conversationId })
    await until(
      async () =>
        (await f.opened.harness.snapshot(LiveDoc, f.opened.root.id, context))?.run !== undefined,
    )
    await f.opened.root.submit(
      { type: 'input', content: 'later only', whenBusy: 'followUp' },
      context,
    )
    // The child gate is still closed and the wait has no completed result.
    expect((await pending.status(context)).status).toBe('placed')
    expect((await latestResult(f.opened))?.role).toBe('toolResult')
    expect(await latestResult(f.opened)).not.toMatchObject({ details: { yielded: true } })
    await f.opened.root.submit({ type: 'input', content: 'wake now', whenBusy: 'steer' }, context)
    await pending.wait(context)
    expect(await latestResult(f.opened)).toMatchObject({ details: { yielded: true } })
    f.childGate.release()
    await f.opened.harness.waitForIdle(context)

    const g = await gatedFixture()
    await g.opened.root.submit({ type: 'input', content: 'HOLD' }, context)
    await until(async () => g.holding.has(1))
    const start = await g.opened.root.submit(
      {
        type: 'input',
        content: 'CALL {"action":"start","agent":"scout","task":"HOLD"}',
        whenBusy: 'steer',
      },
      context,
    )
    await g.opened.root.submit(
      { type: 'input', content: 'already queued', whenBusy: 'steer' },
      context,
    )
    g.parentGate.release()
    await start.wait(context)
    expect(await latestResult(g.opened)).toMatchObject({ details: { yielded: true } })
    const [agent] = await children(g.opened)
    await until(async () => g.holding.has(agent.conversationId))
    expect(
      (await g.opened.harness.snapshot(LiveDoc, agent.conversationId, context))?.run,
    ).toBeDefined()
    g.childGate.release()
    await until(async () => (await reports(g.opened)).length === 1)
    await g.opened.harness.waitForIdle(context)
    expect(await reports(g.opened)).toHaveLength(1)
  })

  it('finishes normally for followUp without duplicating the answer', async () => {
    const f = await gatedFixture()
    const pending = await startCall(f.opened, { action: 'start', agent: 'scout', task: 'HOLD' })
    await until(async () => f.holding.size === 1)
    const followUp = await f.opened.root.submit(
      { type: 'input', content: 'later only', whenBusy: 'followUp' },
      context,
    )
    expect(
      (await f.opened.harness.snapshot(InboxDoc, f.opened.root.id, context))?.items.map(
        (item) => item.mode,
      ),
    ).toEqual(['followUp'])
    f.childGate.release()
    await pending.wait(context)
    await followUp.wait(context)
    expect(await latestResult(f.opened)).toMatchObject({
      content: [{ type: 'text', text: 'Returned model: faux/faux-1\nResult: released' }],
    })
    expect(await latestResult(f.opened)).not.toMatchObject({ details: { yielded: true } })
    expect(await reports(f.opened)).toHaveLength(0)
  })
  it('wakes a pending wait on another child report without losing either answer', async () => {
    const held = { ...gate(), entered: false }
    const f = await gatedFixture(held)
    await call(f.opened, { action: 'start', agent: 'scout', task: 'HOLD', background: true })
    const [waiting] = await children(f.opened)
    await until(async () => f.holding.has(waiting.conversationId))
    await call(f.opened, {
      action: 'start',
      agent: 'scout',
      task: 'other answer',
      background: true,
    })
    await until(async () => held.entered)
    const pending = await startCall(f.opened, { action: 'wait', id: waiting.conversationId })
    held.release()
    await pending.wait(context)
    expect(await latestResult(f.opened)).toMatchObject({
      details: { yielded: true, conversationId: waiting.conversationId },
    })
    expect(
      (await f.opened.harness.snapshot(LiveDoc, waiting.conversationId, context))?.run,
    ).toBeDefined()
    expect(await reports(f.opened)).toHaveLength(1)
    expect(JSON.stringify(await reports(f.opened))).toContain('Child: other answer')
    f.childGate.release()
    await until(async () => (await reports(f.opened)).length === 2)
    await f.opened.root.waitForIdle(context)
    expect(await reports(f.opened)).toHaveLength(2)
  })
  it('stops a pending Reporter before delivery and leaves the child reusable', async () => {
    const held = { ...gate(), entered: false, phase: 'deliver' }
    const f = await fixture(undefined, undefined, held)
    await call(f.opened, {
      action: 'start',
      agent: 'scout',
      task: 'contradicting work',
      background: true,
    })
    await until(async () => held.entered)
    const [child] = await children(f.opened)
    const state = (await f.opened.harness.snapshot(Subagents, f.opened.root.id, context))!
    const action = Object.values(state.actions)[0]
    expect(
      (await f.opened.harness.snapshot(LiveDoc, child.conversationId, context))?.run,
    ).toBeUndefined()
    expect((await call(f.opened, { action: 'stop', id: child.conversationId })).text).toBe(
      `Stopped ${child.conversationId}.`,
    )
    held.release()
    await f.opened.harness.waitForTask(action.reporter, context)
    const view = await (await f.opened.harness.conversation(
      child.conversationId,
      context,
    ))!.context(context)
    expect(view.entries.filter((entry) => entry.model?.[0]?.role === 'user')).toHaveLength(0)
    expect(await reports(f.opened)).toHaveLength(0)
    await call(f.opened, { action: 'message', id: child.conversationId, text: 'fresh reuse' })
    await until(async () => (await reports(f.opened)).length === 1)
    await f.opened.root.waitForIdle(context)
    expect(JSON.stringify(await reports(f.opened))).toContain('Child: fresh reuse')
    expect(JSON.stringify(await reports(f.opened))).not.toContain('contradicting work')
    expect(f.errors).toEqual([])
  })
  it('withdraws captured queued Reporter inputs as well as stopping the current run', async () => {
    const f = await gatedFixture()
    await call(f.opened, { action: 'start', agent: 'scout', task: 'HOLD', background: true })
    const [child] = await children(f.opened)
    await until(async () => f.holding.has(child.conversationId))
    await call(f.opened, { action: 'message', id: child.conversationId, text: 'never execute' })
    const state = (await f.opened.harness.snapshot(Subagents, f.opened.root.id, context))!
    const action = Object.values(state.actions).at(-1)!
    await until(
      async () =>
        (
          await f.opened.harness.commit(
            (tx) => tx.submissionByRequest(child.conversationId, `subagent:${action.reporter}`),
            context,
          )
        )?.status === 'queued',
    )
    await call(f.opened, { action: 'stop', id: child.conversationId })
    expect(
      (await f.opened.harness.snapshot(LiveDoc, child.conversationId, context))?.run,
    ).toBeUndefined()
    f.childGate.release()
    await f.opened.root.waitForIdle(context)
    const view = await (await f.opened.harness.conversation(
      child.conversationId,
      context,
    ))!.context(context)
    expect(view.entries.filter((entry) => entry.model?.[0]?.role === 'user')).toHaveLength(1)
    expect(await reports(f.opened)).toHaveLength(0)
    await call(f.opened, { action: 'message', id: child.conversationId, text: 'fresh reuse' })
    await until(async () => (await reports(f.opened)).length === 1)
    await f.opened.root.waitForIdle(context)
    expect(JSON.stringify(await reports(f.opened))).not.toContain('never execute')
    expect(f.errors).toEqual([])
  })
  it('replays captured stop identities without stopping a newer child run', async () => {
    const f = await gatedFixture()
    await call(f.opened, { action: 'start', agent: 'scout', task: 'HOLD', background: true })
    const [child] = await children(f.opened)
    await until(async () => f.holding.has(child.conversationId))
    const stopGate = stopCaptureGate(f)
    await startCall(f.opened, { action: 'stop', id: child.conversationId })
    await until(async () => stopGate.entered)
    const handle = (await f.opened.harness.conversation(child.conversationId, context))!
    await handle.abort(context)
    const newer = await handle.submit(
      { type: 'input', content: 'HOLD', requestId: 'later-reuse' },
      context,
    )
    await until(
      async () =>
        (await f.opened.harness.snapshot(LiveDoc, child.conversationId, context))?.run !==
        undefined,
    )
    const run = (await f.opened.harness.snapshot(LiveDoc, child.conversationId, context))!.run!
      .taskId
    await f.opened.close()
    hosts.splice(hosts.indexOf(f.opened), 1)
    stopGate.enabled = false
    const resumed = await f.reopen()
    await resumed.root.waitForIdle(context)
    expect(await latestResult(resumed)).toMatchObject({
      content: [{ type: 'text', text: `Stopped ${child.conversationId}.` }],
    })
    expect(
      (await resumed.harness.snapshot(LiveDoc, child.conversationId, context))?.run?.taskId,
    ).toBe(run)
    const submission = (await resumed.harness.submission(newer.id, context))!
    expect(await submission.status(context)).toMatchObject({ status: 'placed' })
    f.childGate.release()
    expect(await submission.wait(context)).toMatchObject({ status: 'done' })
    expect(await reports(resumed)).toHaveLength(0)
    expect(f.errors).toEqual([])
  })

  it('keeps a foreground child running when the parent is stopped', async () => {
    const f = await gatedFixture()
    await startCall(f.opened, { action: 'start', agent: 'scout', task: 'HOLD' })
    await until(async () => f.holding.size === 1)
    const [child] = await children(f.opened)
    await f.opened.root.abort(context)
    expect(
      (await f.opened.harness.snapshot(LiveDoc, child.conversationId, context))?.run,
    ).toBeDefined()
    f.childGate.release()
    await until(async () => (await reports(f.opened)).length === 1)
    await f.opened.root.waitForIdle(context)
    expect(await reports(f.opened)).toHaveLength(1)
  })
  it('releases parallel waits on a steer and preserves every child answer across restart', async () => {
    const f = await gatedFixture()
    await f.opened.root.submit(
      {
        type: 'input',
        content: `CODE text(await Promise.all([1,2].map(() => tools.subagent({action:'start',agent:'scout',task:'HOLD'}))));`,
      },
      context,
    )
    await until(async () => (await children(f.opened)).length === 2 && f.holding.size === 2)
    await (
      await f.opened.root.submit(
        { type: 'input', content: 'parallel steer', whenBusy: 'steer' },
        context,
      )
    ).wait(context)
    expect(await latestResult(f.opened)).toMatchObject({ role: 'toolResult', toolName: 'codemode' })
    const agents = await children(f.opened)
    for (const agent of agents)
      expect(
        (await f.opened.harness.snapshot(LiveDoc, agent.conversationId, context))?.run,
      ).toBeDefined()
    await f.opened.close()
    hosts.splice(hosts.indexOf(f.opened), 1)
    const resumed = await f.reopen()
    expect((await children(resumed)).map((child) => child.conversationId)).toEqual(
      agents.map((child) => child.conversationId),
    )
    f.childGate.release()
    await until(async () => (await reports(resumed)).length === 2)
    await resumed.harness.waitForIdle(context)
    expect(await reports(resumed)).toHaveLength(2)
    for (const child of await children(resumed)) expect(child.reported).toHaveLength(1)
  })

  it('lets the parent message and explicitly stop a foreground child after yielding', async () => {
    const f = await gatedFixture()
    await startCall(f.opened, { action: 'start', agent: 'scout', task: 'HOLD' })
    await until(async () => f.holding.size === 1)
    await (
      await f.opened.root.submit(
        { type: 'input', content: 'change task', whenBusy: 'steer' },
        context,
      )
    ).wait(context)
    const [child] = await children(f.opened)
    const message = await startCall(f.opened, {
      action: 'message',
      id: child.conversationId,
      text: 'replacement',
      steer: true,
    })
    await (
      await f.opened.root.submit(
        { type: 'input', content: 'stop instead', whenBusy: 'steer' },
        context,
      )
    ).wait(context)
    await message.wait(context)
    expect(await latestResult(f.opened)).toMatchObject({
      details: { conversationId: child.conversationId, yielded: true },
    })
    await call(f.opened, { action: 'stop', id: child.conversationId })
    expect(
      (await f.opened.harness.snapshot(LiveDoc, child.conversationId, context))?.run,
    ).toBeUndefined()
    f.childGate.release()
    await f.opened.harness.waitForIdle(context)
    expect(await reports(f.opened)).toHaveLength(0)
    expect(
      (await call(f.opened, { action: 'message', id: child.conversationId, text: 'reuse' })).text,
    ).toBe('Returned model: faux/faux-1\nChild: reuse')
    expect(await reports(f.opened)).toHaveLength(0)
  })

  it('keeps a completed nested answer durable when the enclosing script fails', async () => {
    const f = await fixture()
    await (
      await f.opened.root.submit(
        {
          type: 'input',
          content: `CODE await tools.subagent({action:'start',agent:'scout',task:'keep this answer'}); throw new Error('sibling wait yielded');`,
        },
        context,
      )
    ).wait(context)
    await f.opened.harness.waitForIdle(context)
    const delivered = await reports(f.opened)
    expect(delivered).toHaveLength(1)
    expect(JSON.stringify(delivered)).toContain('Child: keep this answer')
    expect((await children(f.opened))[0].reported).toHaveLength(1)
  })
  it('forks before the calling assistant, keeps child configuration and starts with empty agents', async () => {
    const requests: Parameters<FauxResponseFactory>[0][] = []
    const { opened } = await fixture(undefined, (transcript) => requests.push(transcript))
    await opened.harness.commit(async (tx) => {
      Object.assign(await tx.doc(UiState, opened.root.id), {
        'subagents.selected': opened.root.id,
      })
    }, context)
    await (
      await opened.root.submit(
        { type: 'input', content: 'Remember the parent secret: violet' },
        context,
      )
    ).wait(context)
    await call(opened, { action: 'start', agent: 'scout', task: 'older child' })
    const result = await call(opened, {
      action: 'start',
      agent: 'scout',
      task: 'fork task',
      fork: true,
    })
    expect(result.text).toContain('Child: fork task')
    const request = requests.find((candidate) =>
      candidate.messages.some(
        (message) => message.role === 'user' && message.content === 'fork task',
      ),
    )!
    expect(request).toBeDefined()
    expect(JSON.stringify(request.messages)).toContain('Remember the parent secret: violet')
    expect(request.messages.findLast((message) => message.role !== 'system')).toMatchObject({
      role: 'user',
      content: 'fork task',
    })
    expect(
      request.messages.some(
        (message) =>
          message.role === 'assistant' &&
          Array.isArray(message.content) &&
          message.content.some(
            (part) =>
              part.type === 'toolCall' &&
              part.name === 'subagent' &&
              (part.arguments as { fork?: boolean }).fork === true,
          ),
      ),
    ).toBe(false)
    const childId = (await children(opened)).at(-1)!.conversationId
    const child = (await opened.harness.conversation(childId, context))!
    const agent = await child.agent(context)
    expect(agent.instructions).toBe('Original instructions')
    expect(agent.extensions.map((extension) => extension.name)).not.toContain('subagents')
    expect(agent.tools.map((tool) => tool.name).toSorted()).toEqual(['bash', 'read'])
    expect(await opened.harness.snapshot(Subagents, childId, context)).toBeUndefined()
    expect(await opened.harness.snapshot(UiState, childId, context)).toEqual({
      'subagents.selected': opened.root.id,
    })
    expect(await opened.harness.snapshot(Metadata, childId, context)).toMatchObject({
      label: 'scout',
      title: 'fork task',
    })
  })
  it('keeps nested parallel starts distinct and delivers a subsequent nested message', async () => {
    const { opened } = await fixture()
    await (
      await opened.root.submit(
        {
          type: 'input',
          content: `CODE const results = await Promise.all(['first','second'].map(task => tools.subagent({action:'start',agent:'scout',task}))); text(results);`,
        },
        context,
      )
    ).wait(context)
    const agents = await children(opened)
    expect(agents).toHaveLength(2)
    expect(new Set(agents.map((agent) => agent.conversationId)).size).toBe(2)
    let view = await opened.root.context(context)
    expect(JSON.stringify(view.entries)).toContain('Child: first')
    expect(JSON.stringify(view.entries)).toContain('Child: second')
    await (
      await opened.root.submit(
        {
          type: 'input',
          content: `CODE const child = await tools.subagent({action:'start',agent:'scout',task:'third'}); text(await tools.subagent({action:'message',id:JSON.parse(await tools.subagent({action:'list'})).at(-1).conversationId,text:'follow-up'}));`,
        },
        context,
      )
    ).wait(context)
    view = await opened.root.context(context)
    expect(JSON.stringify(view.entries)).toContain('Child: follow-up')
  })
  it('extends an earlier definition with an addTools overlay and refuses a tools list', async () => {
    const repo = await directory(),
      home = await directory(),
      cwd = await directory()
    await mkdir(join(repo, 'agents'))
    await mkdir(join(home, '.ultimate/agents'), { recursive: true })
    await mkdir(join(cwd, '.ultimate/agents'), { recursive: true })
    const modelRuntime = await ModelRuntime.create()
    await writeFile(join(repo, 'agents/scout.md'), definition())
    await writeFile(
      join(repo, 'agents/open.md'),
      definition().replace('name: scout', 'name: open').replace('tools: [read, bash]\n', ''),
    )
    await writeFile(
      join(home, '.ultimate/agents/scout.md'),
      '---\nname: scout\naddTools: [write, read]\n---\n',
    )
    await writeFile(
      join(cwd, '.ultimate/agents/scout.md'),
      '---\nname: scout\naddTools: [laravel]\n---\n\nUse laravel for the database.\n',
    )
    await writeFile(
      join(cwd, '.ultimate/agents/open.md'),
      '---\nname: open\naddTools: [laravel]\n---\n',
    )
    for (const [name, text] of [
      ['listed', '---\nname: scout\naddTools: [x]\ntools: [read]\n---\n'],
      ['unknown', '---\nname: scout\naddTools: []\ncolour: red\n---\n'],
      ['orphan', '---\nname: nobody\naddTools: [x]\n---\n'],
    ])
      await writeFile(join(cwd, `.ultimate/agents/${name}.md`), text)
    new ProjectTrustStore(join(home, '.ultimate')).set(cwd, true)
    const found = await discoverAgents(repo, cwd, home, modelRuntime)
    const scout = found.definitions.find((agent) => agent.name === 'scout')!
    expect(scout).toMatchObject({
      source: 'builtin',
      path: join(repo, 'agents/scout.md'),
      tools: ['read', 'bash', 'write', 'laravel'],
      instructions: `Original instructions\n\n## Project additions\n\nUse laravel for the database.`,
      overlays: [join(home, '.ultimate/agents/scout.md'), join(cwd, '.ultimate/agents/scout.md')],
    })
    // A definition that inherits every tool stays without a list.
    expect(found.definitions.find((agent) => agent.name === 'open')?.tools).toBeUndefined()
    expect(Object.fromEntries(found.errors.map((file) => [file.name, file.error]))).toEqual({
      listed: expect.stringContaining('adds tools with addTools, not tools'),
      unknown: expect.stringContaining('Unknown field: colour'),
      orphan: expect.stringContaining('needs an earlier definition named nobody'),
    })
    expect(found.replaced).toEqual([])
  })
  it('lets an overlay override settings such as model and thinking', async () => {
    const repo = await directory(),
      home = await directory(),
      cwd = await directory()
    await mkdir(join(repo, 'agents'))
    await mkdir(join(cwd, '.ultimate/agents'), { recursive: true })
    const modelRuntime = await ModelRuntime.create()
    await writeFile(join(repo, 'agents/scout.md'), definition())
    // An empty addTools marks a settings-only overlay.
    await writeFile(
      join(cwd, '.ultimate/agents/scout.md'),
      '---\nname: scout\nmodel: anthropic/claude-opus-4-8\nthinking: high\nfast: true\ndescription: Our scout\naddTools: []\n---\n',
    )
    new ProjectTrustStore(join(home, '.ultimate')).set(cwd, true)
    const found = await discoverAgents(repo, cwd, home, modelRuntime)
    expect(found.definitions.find((agent) => agent.name === 'scout')).toMatchObject({
      source: 'builtin',
      description: 'Our scout',
      model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
      thinking: 'high',
      fast: true,
      tools: ['read', 'bash'],
      instructions: 'Original instructions',
    })
    expect(found.errors).toEqual([])
    expect(found.replaced).toEqual([])
  })

  it('discovers model and thinking settings and reports unknown models', async () => {
    const repo = await directory(),
      home = await directory(),
      cwd = await directory()
    await mkdir(join(repo, 'agents'))
    const modelRuntime = await ModelRuntime.create()
    for (const [name, model, thinking] of [
      ['exact', 'anthropic/claude-opus-4-8', ''],
      ['suffix', 'anthropic/claude-opus-4-8:high', ''],
      ['explicit', 'anthropic/claude-opus-4-8:high', 'thinking: low\n'],
      ['unknown', 'anthropic/ultimate-nonexistent-model', ''],
      ['missing', 'ultimate-nonexistent-model', ''],
    ])
      await writeFile(
        join(repo, `agents/${name}.md`),
        definition(name)
          .replace('name: scout', `name: ${name}`)
          .replace('tools: [read, bash]', `model: ${model}\n${thinking}`),
      )
    new ProjectTrustStore(join(home, '.ultimate')).set(cwd, true)
    const found = await discoverAgents(repo, cwd, home, modelRuntime)
    expect(found.definitions.find((agent) => agent.name === 'exact')?.model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-8',
    })
    expect(found.definitions.find((agent) => agent.name === 'suffix')?.thinking).toBe('high')
    expect(found.definitions.find((agent) => agent.name === 'explicit')?.thinking).toBe('low')
    expect(found.errors.find((file) => file.name === 'unknown')?.error).toContain(
      'model: Model "ultimate-nonexistent-model" not found for provider "anthropic". Using custom model id.',
    )
    expect(found.errors.find((file) => file.name === 'missing')?.error).toContain(
      'model: Model "ultimate-nonexistent-model" not found.',
    )
  })
  it('parses definitions with Pi frontmatter and validates their fields', () => {
    expect(
      parseDefinition(
        '---\nname: scout\ndescription: >\n  A read-only scout\n  that searches.\nmodel: openai-codex/gpt-5.4\nthinking: max\ntools:\n  - read\n  - bash\n---\nSearch\n',
        'scout.md',
      ),
    ).toEqual({
      name: 'scout',
      description: 'A read-only scout that searches.',
      path: 'scout.md',
      instructions: 'Search',
      model: 'openai-codex/gpt-5.4',
      thinking: 'max',
      tools: ['read', 'bash'],
    })
    // `summaries: false` survives a save: only the field's off state is written.
    const quiet = parseDefinition(
      definition().replace('tools: [read, bash]', 'summaries: false'),
      'test',
    )
    expect(quiet).toMatchObject({ summaries: false })
    expect(serializeDefinition('scout', quiet, quiet.instructions)).toContain(
      '\nsummaries: false\n',
    )
    expect(serializeDefinition('scout', { description: 'Search' }, 'Search')).not.toContain(
      'summaries',
    )
    for (const [from, to, error] of [
      [
        'tools: [read, bash]',
        'tools: [read, bash]\nthinking: nonsense',
        'thinking must be one of off, minimal, low, medium, high, xhigh, max',
      ],
      ['description: Search', 'description: " "', 'description is required'],
      ['name: scout', 'name: a scout', 'name must be a nonempty identifier'],
      ['tools: [read, bash]', 'tools: read', 'tools must be a list of tool names'],
      ['tools: [read, bash]', 'model: " "', 'model must be a nonempty string'],
      ['tools: [read, bash]', 'tool: [read]', 'Unknown field: tool'],
      ['tools: [read, bash]', 'isolate: remote', 'isolate must be none or worktree'],
      ['tools: [read, bash]', 'summaries: never', 'summaries must be a boolean'],
      ['Original instructions', '', 'Instructions are required'],
    ])
      expect(() => parseDefinition(definition().replace(from, to), 'test')).toThrow(error)
  })
  it('saves a definition as a project override that start uses, writes nothing when invalid, and deletes it', async () => {
    const { prepared, opened, ultimateRoot, userHome } = await fixture()
    const ctx = {
      host: { ...prepared, harness: () => opened.harness },
    } as unknown as ActionContext
    const project = join(prepared.projectRoot, '.ultimate/agents')
    const override = {
      name: 'scout',
      scope: 'project',
      frontmatter: {
        description: 'Project scout: reads only',
        tools: ['read'],
        denyTools: ['instance'],
        thinking: 'high',
        resident: true,
      },
      instructions: '# Project\n\nRead the code.\n',
    }
    await expect(actions.saveDefinition(override, ctx)).rejects.toThrow(
      "Choose this project's local setup",
    )
    expect(await actions.definitions(null, ctx)).toMatchObject({ projectSetup: 'undecided' })
    new ProjectTrustStore(join(userHome, '.ultimate')).set(prepared.projectRoot, true)
    const listed = await actions.definitions(null, ctx)
    expect(listed).toMatchObject({
      projectSetup: 'trusted',
      scopes: { user: join(userHome, '.ultimate/agents'), project },
      definitions: [{ name: 'scout', source: 'builtin' }],
    })
    expect(listed.main.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['read', 'bash', 'codemode']),
    )
    expect(listed.main.tools.map((tool) => tool.name)).toContain('subagent')
    const builtin = await readFile(join(ultimateRoot, 'agents/scout.md'), 'utf8')
    await actions.saveDefinition(override, ctx)
    const raw = await readFile(join(project, 'scout.md'), 'utf8')
    expect(raw).toBe(
      '---\nname: scout\ndescription: "Project scout: reads only"\nthinking: high\ntools: [read]\ndenyTools: [instance]\nresident: true\n---\n\n# Project\n\nRead the code.\n',
    )
    expect(await readFile(join(ultimateRoot, 'agents/scout.md'), 'utf8')).toBe(builtin)
    const found = await discoverAgents(
      ultimateRoot,
      prepared.projectRoot,
      userHome,
      prepared.modelRuntime,
    )
    expect(found.definitions.find((agent) => agent.name === 'scout')).toMatchObject({
      source: 'project',
      description: 'Project scout: reads only',
      resident: true,
      tools: ['read'],
      denyTools: ['instance'],
      thinking: 'high',
      instructions: '# Project\n\nRead the code.',
    })
    expect(await actions.definition({ name: 'scout' }, ctx)).toMatchObject({
      source: 'project',
      path: join(project, 'scout.md'),
      raw,
      files: ['builtin', 'project'],
      definition: { instructions: '# Project\n\nRead the code.' },
    })
    await call(opened, { action: 'start', agent: 'scout', task: 'facts' })
    const child = (await children(opened)).at(-1)!
    const agent = await (await opened.harness.conversation(child.conversationId, context))!.agent(
      context,
    )
    expect(agent.tools.map((tool) => tool.name)).toEqual(['read'])
    expect(agent.instructions).toBe('# Project\n\nRead the code.')
    for (const [change, error] of [
      [{ frontmatter: { ...override.frontmatter, description: ' ' } }, 'description is required'],
      [{ frontmatter: { ...override.frontmatter, thinking: 'loud' } }, 'thinking must be one of'],
      [{ frontmatter: { ...override.frontmatter, resident: 'yes' } }, 'resident must be a boolean'],
      [{ frontmatter: { ...override.frontmatter, model: 'anthropic/nonexistent' } }, 'model:'],
      [{ instructions: ' ' }, 'Instructions are required'],
      [{ name: '../scout' }, 'name must be a nonempty identifier'],
      [{ create: true }, 'A definition named scout exists already'],
      [{ scope: 'builtin' }, 'scope must be user or project'],
    ] as const)
      await expect(actions.saveDefinition({ ...override, ...change }, ctx)).rejects.toThrow(error)
    expect(await readFile(join(project, 'scout.md'), 'utf8')).toBe(raw)
    expect(await readdir(project)).toEqual(['scout.md'])
    await actions.saveDefinition(
      {
        name: 'builder',
        scope: 'user',
        create: true,
        frontmatter: { description: 'Builds', isolate: 'worktree' },
        instructions: 'Build it',
      },
      ctx,
    )
    expect(await actions.definition({ name: 'builder' }, ctx)).toMatchObject({
      source: 'user',
      files: ['user'],
      definition: { isolate: 'worktree', instructions: 'Build it' },
    })
    await writeFile(join(project, 'builder.md'), 'broken')
    expect(await actions.definition({ name: 'builder' }, ctx)).toMatchObject({
      source: 'user',
      files: ['user', 'project'],
      invalid: { source: 'project', error: expect.stringContaining('frontmatter') },
    })
    await actions.deleteDefinition({ name: 'scout', scope: 'project' }, ctx)
    expect(await actions.definition({ name: 'scout' }, ctx)).toMatchObject({
      source: 'builtin',
      files: ['builtin'],
    })
    await expect(
      actions.deleteDefinition({ name: 'scout', scope: 'project' }, ctx),
    ).rejects.toThrow('No project definition named scout')
    await expect(
      actions.deleteDefinition({ name: 'scout', scope: 'builtin' }, ctx),
    ).rejects.toThrow('scope must be user or project')
  })
  it('saves a definition an overlay extends as that overlay, holding only what differs from the base', async () => {
    const { prepared, opened, userHome, ultimateRoot } = await fixture()
    const ctx = {
      host: { ...prepared, harness: () => opened.harness },
    } as unknown as ActionContext
    const overlay = join(userHome, '.ultimate/agents/scout.md')
    await mkdir(join(userHome, '.ultimate/agents'), { recursive: true })
    await writeFile(overlay, '---\nname: scout\naddTools: [write]\n---\nMore.\n')
    const save = (frontmatter: Record<string, unknown>, instructions: string) =>
      actions.saveDefinition(
        {
          name: 'scout',
          scope: 'user',
          frontmatter: { description: 'Search', resident: false, ...frontmatter },
          instructions,
        },
        ctx,
      )
    await save(
      { model: 'faux/faux-1', tools: ['read', 'bash', 'write', 'edit'] },
      'Original instructions\n\n## User additions\n\nMore.\nEven more.',
    )
    expect(await readFile(overlay, 'utf8')).toBe(
      '---\nname: scout\naddTools: [write, edit]\nmodel: faux/faux-1\n---\n\nMore.\nEven more.\n',
    )
    expect(await readFile(join(ultimateRoot, 'agents/scout.md'), 'utf8')).toBe(definition())
    expect(await actions.definition({ name: 'scout' }, ctx)).toMatchObject({
      source: 'builtin',
      definition: {
        tools: ['read', 'bash', 'write', 'edit'],
        model: { provider: 'faux', modelId: 'faux-1' },
        instructions: 'Original instructions\n\n## User additions\n\nMore.\nEven more.',
        overlays: [overlay],
      },
    })
    const written = await readFile(overlay, 'utf8')
    await expect(save({ tools: ['read', 'write'] }, 'Original instructions')).rejects.toThrow(
      'An overlay cannot remove bash',
    )
    await expect(save({ tools: ['read', 'bash'] }, 'Rewritten')).rejects.toThrow(
      'An overlay cannot change the instructions it starts with',
    )
    expect(await readFile(overlay, 'utf8')).toBe(written)
  })
  it('keeps the tools an overlay adds to a base that inherits every tool when its form is saved', async () => {
    const { prepared, opened, userHome, ultimateRoot } = await fixture()
    const ctx = {
      host: { ...prepared, harness: () => opened.harness },
    } as unknown as ActionContext
    await writeFile(
      join(ultimateRoot, 'agents/helper.md'),
      '---\nname: helper\ndescription: Helps\n---\nHelp.\n',
    )
    const overlay = join(userHome, '.ultimate/agents/helper.md')
    await mkdir(join(userHome, '.ultimate/agents'), { recursive: true })
    await writeFile(overlay, '---\nname: helper\naddTools: [debug]\n---\n')
    // The form shows an inherit-all definition without a tools list, so it sends none.
    await actions.saveDefinition(
      {
        name: 'helper',
        scope: 'user',
        frontmatter: { description: 'Helps more', resident: false },
        instructions: 'Help.',
      },
      ctx,
    )
    expect(await readFile(overlay, 'utf8')).toBe(
      '---\nname: helper\naddTools: [debug]\ndescription: Helps more\n---\n',
    )
    expect(await actions.definition({ name: 'helper' }, ctx)).toMatchObject({
      definition: { description: 'Helps more', addTools: ['debug'] },
    })
  })
  it('foreground returns the answer, exposes child details, inherits the parent and rereads scout on next start', async () => {
    const { opened, ultimateRoot } = await fixture()
    const result = await call(opened, { action: 'start', agent: 'scout', task: 'facts' })
    expect(result.text).toBe('Returned model: faux/faux-1\nChild: facts')
    const [first] = await children(opened)
    expect(result.tool.model?.[0]).toMatchObject({
      details: { conversationId: first.conversationId },
    })
    const record = await opened.harness.commit(
      (tx) => tx.conversation(first.conversationId),
      context,
    )
    expect(record?.owner?.conversationId).toBe(opened.root.id)
    const child = (await opened.harness.conversation(first.conversationId, context))!
    const agent = await child.agent(context)
    expect(agent.tools.map((tool) => tool.name)).toEqual(['read', 'bash'])
    expect(agent.model).toEqual((await opened.root.agent(context)).model)
    expect(agent.instructions).toBe('Original instructions')
    await writeFile(join(ultimateRoot, 'agents/scout.md'), definition('Updated instructions'))
    await call(opened, { action: 'start', agent: 'scout', task: 'more facts' })
    const second = (await children(opened))[1]
    expect(
      (await (await opened.harness.conversation(second.conversationId, context))!.agent(context))
        .instructions,
    ).toBe('Updated instructions')
    expect(await opened.harness.snapshot(Metadata, first.conversationId, context)).toEqual({
      label: 'scout',
      title: 'facts',
    })
    expect(
      (
        await call(opened, {
          action: 'message',
          id: first.conversationId,
          text: 'next',
          steer: true,
        })
      ).text,
    ).toBe('Returned model: faux/faux-1\nChild: next')
    expect((await call(opened, { action: 'wait', id: first.conversationId })).text).toBe(
      'Returned model: faux/faux-1\nChild: next',
    )
    const listed = JSON.parse((await call(opened, { action: 'list' })).text)
    expect(listed).toHaveLength(2)
    expect(listed[0]).toMatchObject({ conversationId: first.conversationId, busy: false })
    // Each start is one event in its creating commit; messaging and waiting start nothing.
    const log = eventHost(() => opened.harness, 'test').eventLog
    expect((await log.recent({ events: [Started] })).map((event) => event.data)).toEqual(
      [second, first].map((started) => ({
        id: started.conversationId,
        agent: 'scout',
        kind: 'child',
        model: 'faux/faux-1',
        thinking: 'off',
        parent: opened.root.id,
      })),
    )
  })
  it('background returns immediately, survives parent abort and restart, and reports exactly once', async () => {
    const f = await gatedFixture()
    const { opened } = f
    const result = await call(opened, {
      action: 'start',
      agent: 'scout',
      task: 'HOLD',
      background: true,
    })
    expect(await children(opened)).toHaveLength(1)
    const [child] = await children(opened)
    expect(result.text).toContain(String(child.conversationId))
    expect(result.tool.model?.[0]).toMatchObject({
      details: { conversationId: child.conversationId, background: true },
    })
    expect((await opened.harness.snapshot(LiveDoc, opened.root.id, context))?.run).toBeUndefined()
    expect(
      (await opened.harness.snapshot(LiveDoc, child.conversationId, context))?.run,
    ).toBeDefined()
    await opened.root.abort(context)
    expect(
      (await opened.harness.snapshot(LiveDoc, child.conversationId, context))?.run,
    ).toBeDefined()
    await opened.close()
    hosts.splice(hosts.indexOf(opened), 1)
    const resumed = await f.reopen()
    f.childGate.release()
    await until(async () => (await reports(resumed)).length === 1)
    await resumed.harness.waitForIdle(context)
    expect(await children(resumed)).toHaveLength(1)
    expect(await reports(resumed)).toHaveLength(1)
    const view = await resumed.root.context(context)
    expect(
      view.entries.some(
        (entry) =>
          entry.model?.[0]?.role === 'assistant' &&
          entry.model[0].content.some(
            (part) => part.type === 'text' && part.text === 'Report received',
          ),
      ),
    ).toBe(true)
    await call(resumed, { action: 'message', id: child.conversationId, text: 'another' })
    await until(async () => (await reports(resumed)).length === 2)
    await resumed.root.waitForIdle(context)
    expect((await children(resumed))[0].reported).toHaveLength(2)
  })
  it('delivers a background answer as a steer while the parent is in a tool round', async () => {
    let releaseParent!: () => void
    let releaseChild!: () => void
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve
    })
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve
    })
    let parentHolding = false
    let childHolding = false
    const { opened } = await fixture(
      defineExtension({
        name: 'hold',
        tools: [
          defineTool({
            name: 'hold',
            description: 'Hold the current tool round',
            parameters: obj({}),
            execute: async (_args, api) => {
              if (api.conversationId === 1) {
                parentHolding = true
                await parentGate
              } else {
                childHolding = true
                await childGate
              }
              return { output: [{ type: 'text', text: 'released' }] }
            },
          }),
        ],
      }),
    )
    try {
      await call(opened, { action: 'start', agent: 'scout', task: 'HOLD', background: true })
      await until(async () => childHolding)
      await opened.root.submit({ type: 'input', content: 'HOLD' }, context)
      await until(async () => parentHolding)
      releaseChild()
      await until(
        async () =>
          (await opened.harness.snapshot(InboxDoc, opened.root.id, context))?.items.some(
            (item) =>
              item.mode !== 'write' &&
              typeof item.content === 'string' &&
              item.content.startsWith('[subagent'),
          ) === true,
      )
      releaseParent()
      await opened.root.waitForIdle(context)
      expect(await reports(opened)).toHaveLength(1)
    } finally {
      releaseChild()
      releaseParent()
    }
  })
  it('withdraws a queued background report when wait returns the same answer', async () => {
    let releaseParent!: () => void
    let releaseChild!: () => void
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve
    })
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve
    })
    let parentHolding = false
    let childHolding = false
    const { opened } = await fixture(
      defineExtension({
        name: 'hold',
        tools: [
          defineTool({
            name: 'hold',
            description: 'Hold the current tool round',
            parameters: obj({}),
            execute: async (_args, api) => {
              if (api.conversationId === 1) {
                parentHolding = true
                await parentGate
              } else {
                childHolding = true
                await childGate
              }
              return { output: [{ type: 'text', text: 'released' }] }
            },
          }),
        ],
      }),
    )
    try {
      await call(opened, { action: 'start', agent: 'scout', task: 'HOLD', background: true })
      const [child] = await children(opened)
      await until(async () => childHolding)
      await opened.root.submit({ type: 'input', content: 'HOLD' }, context)
      await until(async () => parentHolding)
      // One steer is placed per boundary, so the report stays queued while the parent waits.
      await opened.root.submit(
        {
          type: 'input',
          content: `CALL ${JSON.stringify({ action: 'wait', id: child.conversationId })}`,
          whenBusy: 'steer',
        },
        context,
      )
      releaseChild()
      await until(
        async () =>
          (await opened.harness.snapshot(InboxDoc, opened.root.id, context))?.items.length === 2,
      )
      releaseParent()
      await opened.root.waitForIdle(context)
      const view = await opened.root.context(context)
      const results = view.entries.flatMap((entry) => {
        const message = entry.model?.[0]
        return message?.role === 'toolResult' && message.toolName === 'subagent'
          ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
          : []
      })
      expect(results.at(-1)).toBe('Returned model: faux/faux-1\nResult: released')
      expect(await reports(opened)).toHaveLength(0)
      expect((await opened.harness.snapshot(InboxDoc, opened.root.id, context))?.items).toEqual([])
    } finally {
      releaseChild()
      releaseParent()
    }
  })
  it('replays an interrupted foreground wait using its existing independent child', async () => {
    const f = await gatedFixture()
    await startCall(f.opened, { action: 'start', agent: 'scout', task: 'HOLD' })
    await until(async () => f.holding.size === 1)
    const [before] = await children(f.opened)
    await f.opened.close()
    hosts.splice(hosts.indexOf(f.opened), 1)
    const resumed = await f.reopen()
    f.childGate.release()
    await resumed.root.waitForIdle(context)
    expect(await children(resumed)).toHaveLength(1)
    expect((await children(resumed))[0].conversationId).toBe(before.conversationId)
    const view = await resumed.root.context(context)
    const results = view.entries.filter((entry) => entry.kind === 'pi.tool-result')
    expect(results).toHaveLength(1)
    expect(results[0].model?.[0]).toMatchObject({
      content: [{ type: 'text', text: 'Returned model: faux/faux-1\nResult: released' }],
      details: { conversationId: before.conversationId },
      isError: false,
    })
  })
  it('stops a background child, suppresses its aborted report, and leaves it reusable', async () => {
    const { opened } = await gatedFixture()
    await call(opened, { action: 'start', agent: 'scout', task: 'HOLD', background: true })
    expect(await children(opened)).toHaveLength(1)
    const [child] = await children(opened)
    expect((await call(opened, { action: 'stop', id: child.conversationId })).text).toBe(
      `Stopped ${child.conversationId}.`,
    )
    expect(
      (await opened.harness.snapshot(LiveDoc, child.conversationId, context))?.run,
    ).toBeUndefined()
    expect(await reports(opened)).toHaveLength(0)
    await call(opened, { action: 'message', id: child.conversationId, text: 'reuse', steer: true })
    await until(async () => (await reports(opened)).length === 1)
  })
})
