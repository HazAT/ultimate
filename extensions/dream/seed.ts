import type { Tx } from '@earendil-works/pi-durable'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { configure, defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { readJson, writeJson } from '../../lib/json-file.ts'
import { openQuestion } from '../../lib/message-state.ts'
import { Standing, SubagentsApi } from '../subagents/api.ts'
import type { MemoryItem } from '../lineage/refs.ts'
import type { Todo } from '../todos/refs.ts'
import { Branch, LineageApi, Roots, Tally } from '../lineage/api.ts'
import { Messages, MessagesApi } from '../messages/api.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import { AgentDoc } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { AutomationListItem } from '../automations/types.ts'
import type { Automation } from '../automations/types.ts'
import { BuiltInDoc, PauseDoc } from './built-ins.ts'
import { deliver } from './delivery.ts'
import { DreamDoc } from './refs.ts'
import type { Dream, Prepared, Sleep } from './refs.ts'
import type { Seed } from './types.ts'

export const Next = defineDoc<{ prepared?: Prepared; sleep?: Sleep; dream?: Dream }>({
  kind: DreamDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

export const SeedState = defineDoc<{
  applied?: number
  automations: string[]
  branches?: Record<string, ConversationId>
  scripts?: string[]
  questions?: string[]
}>({
  kind: 'dream.seed',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ automations: [] }),
})

const portableTrigger = (item: Seed['automations'][number]) =>
  (!!item.prompt || !!item.subscribers?.length) && !item.condition?.of.startsWith('#')

const conditionOf = ({
  metric,
  of,
  above,
  cooldownMs,
  idleFor,
}: NonNullable<Automation['condition']>) => ({
  metric,
  of,
  above,
  cooldownMs,
  ...(idleFor ? { idleFor } : {}),
})

const builtInOf = (item: Automation | undefined) =>
  item
    ? {
        enabled: item.enabled,
        ...(item.condition ? { condition: conditionOf(item.condition) } : {}),
      }
    : null

async function exportedDocument<T>(
  host: ExtensionHost,
  tx: Tx,
  kind: string,
  id = ROOT_CONVERSATION_ID,
): Promise<T> {
  const token = host.doc(kind)
  if (!token) throw new Error(`Chapter seed needs document ${kind}`)
  return (await tx.doc(token, id)) as unknown as T
}

const STANDING_OR_RUN_LABELS = new Set(['watcher', 'automation', 'agent', 'lander'])

async function carriedBranches(host: ExtensionHost, tx: Tx, ultimate: ConversationId) {
  const roots = (await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots
  const standing = new Set(Object.values(await tx.doc(Standing, ROOT_CONVERSATION_ID)))
  const concluded = await host.need(ConversationsApi).concludedIn(tx)
  const workspaces = (await tx.doc(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID)).items
  const dream = (await tx.doc(Next, ROOT_CONVERSATION_ID)).dream?.branch
  const abstracts: Record<string, { text: string }> = {}
  for (const root of roots) Object.assign(abstracts, (await tx.doc(Tally, root)).abstracts)
  const branches: Seed['branches'] = []
  let cursor
  do {
    const page = await tx.scanConversations({}, 100, cursor)
    for (const record of page.items) {
      const id = record.id
      if (record.owner || roots.includes(id) || standing.has(id) || id === ultimate) continue
      if (concluded.has(id) || id === dream || !(await tx.doc(Branch, id)).branch) continue
      const metadata = await tx.doc(host.metadata, id)
      if (metadata.label && STANDING_OR_RUN_LABELS.has(metadata.label)) continue
      const agent = await tx.doc(AgentDoc, id)
      const workspace = workspaces[String(id)]
      branches.push({
        id,
        title: metadata.title ?? `#${id}`,
        ...(metadata.label ? { label: metadata.label } : {}),
        ...(agent.instructions ? { instructions: agent.instructions } : {}),
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.thinkingLevel ? { thinking: agent.thinkingLevel } : {}),
        ...(workspace?.branch && workspace.state !== 'removed' ? { git: workspace.branch } : {}),
        ...(abstracts[String(id)] ? { abstract: abstracts[String(id)].text } : {}),
      })
    }
    cursor = page.next
  } while (cursor)
  return branches
}

const prototypeFreeMemoryIndex = () => Object.create(null) as Record<string, MemoryItem>
const detachTransactionOverlays = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
export async function buildSeed(host: ExtensionHost, prepared: Prepared): Promise<Seed> {
  const signal = new AbortController().signal
  const automations = (await host.invoke(
    'automations',
    'list',
    null,
    signal,
  )) as AutomationListItem[]
  return host.harness().commit(async (tx) => {
    const roots = (await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots
    const memories = prototypeFreeMemoryIndex()
    const about = new Set<string>()
    for (const root of roots) {
      const source = await exportedDocument<{
        memories: Record<string, MemoryItem>
      }>(host, tx, 'lineage.memory', root)
      for (const [slug, memory] of Object.entries(source.memories)) {
        if (slug.startsWith('about-')) about.add(slug)
        if (!memories[slug] || memory.updated > memories[slug].updated) memories[slug] = memory
      }
    }
    const questions: Seed['questions'] = []
    for (const message of (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages) {
      if (!openQuestion(message)) continue
      const ref = `#${message.id}`
      questions.push({
        text: message.text,
        ref,
        ...(typeof message.from === 'number' ? { from: message.from } : {}),
        ...(message.questions?.length ? { questions: message.questions } : {}),
      })
    }
    for (const slug of about)
      if (!memories[slug]) throw new Error(`Chapter seed lost user memory ${slug}`)
    const todos = (await exportedDocument<{ items: Todo[] }>(host, tx, 'todos')).items
      .filter((item) => item.done === undefined)
      .map(({ text, owner }) => ({ text, owner }))
    const own = (await tx.doc(BuiltInDoc, ROOT_CONVERSATION_ID)).id
    const builtIn = automations.find((item) => item.id === own)
    const ownPause = (await tx.doc(PauseDoc, ROOT_CONVERSATION_ID)).id
    const builtInPause = automations.find((item) => item.id === ownPause)
    const ultimate = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
    if (ultimate === undefined) throw new Error('@ultimate has no conversation yet')
    const triggers = automations
      .filter(
        (item) =>
          item.id !== own &&
          item.id !== ownPause &&
          item.enabled &&
          (item.schedule || item.event || item.condition),
      )
      .map((item) => {
        const { name, prompt, agent, model, thinking } = item
        const standingSubscribers = item.subscribers.filter(
          (s): s is string => typeof s === 'string',
        )
        return {
          name,
          prompt,
          ...(standingSubscribers.length ? { subscribers: standingSubscribers } : {}),
          ...(item.schedule ? { schedule: item.schedule } : {}),
          ...(item.event
            ? {
                event: {
                  name: item.event.name,
                  ...(item.event.where ? { where: item.event.where } : {}),
                },
              }
            : {}),
          ...(item.condition ? { condition: conditionOf(item.condition) } : {}),
          ...(agent ? { agent } : {}),
          ...(model ? { model } : {}),
          ...(thinking ? { thinking } : {}),
        }
      })
    const names = new Set<string>()
    for (const { name } of triggers) {
      if (names.has(name)) throw new Error(`Chapter seed needs unique automation names: ${name}`)
      names.add(name)
    }
    const branches = await carriedBranches(host, tx, ultimate)
    const watchers = automations
      .filter((item) => item.enabled && item.script)
      .map(({ id, scope, name, script, prompt, agent, model, thinking, subscribers, folder }) => ({
        id,
        ...(scope ? { scope } : {}),
        name,
        ask: script!.ask,
        once: script!.once,
        ...(script!.secrets?.length ? { secrets: script!.secrets } : {}),
        ...(subscribers?.some((s) => typeof s === 'number')
          ? { subscribers: subscribers.filter((s): s is ConversationId => typeof s === 'number') }
          : {}),
        ...(folder ? { folder } : {}),
        ...(prompt ? { prompt } : {}),
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
        ...(thinking ? { thinking } : {}),
      }))
    return detachTransactionOverlays({
      from: { name: host.chapter.name, number: host.chapter.number },
      learned: prepared.learned,
      memories,
      todos,
      questions,
      automations: triggers,
      scripts: watchers,
      branches,
      counts: {
        memories: Object.keys(memories).length,
        todos: todos.length,
        questions: questions.length,
        automations: triggers.length,
        scripts: watchers.length,
        branches: branches.length,
      },
      builtIn: builtInOf(builtIn),
      builtInPause: builtInOf(builtInPause),
      continues: { conversation: ultimate, handoff: prepared.handoff },
    })
  }, context)
}

export const writeSeed = (dir: string, seed: Seed) => writeJson(join(dir, 'seed.json'), seed)

function chapterText(host: ExtensionHost, seed: Seed) {
  const { from } = seed
  return [
    `We just woke up in Chapter ${host.chapter.number} · ${host.chapter.name}. Chapter ${from.number} · ${from.name} stays on disk: read it with codemode \`ultimate.entries(id, { chapter: '${from.name}' })\` / \`search\` / \`conversations\`; ids continue across chapters, so \`#123\` sources and links into it still name one conversation; write cross-chapter links as \`${from.name}#123\`.`,
    ...seed.learned.map((line) => `- ${line}`),
    `Carried: ${Object.entries(seed.counts)
      .map(([kind, count]) => `${count} ${kind}`)
      .join(', ')}.`,
    '',
    `Before falling asleep, you wrote this handover to yourself (#${seed.continues.conversation} in ${from.name}):`,
    '<handoff>',
    seed.continues.handoff,
    '</handoff>',
    '',
    'Greet the user in one or two lines, say you are ready, then continue that work: check what is still open (branches, questions, to-dos) and pick it up. The user may check you in a side chat: what this project is, what is open, what the rules are and who you work with.',
  ].join('\n')
}

export async function applySeed(host: ExtensionHost) {
  const seed = await readJson<Seed | undefined>(join(host.chapter.dir, 'seed.json'), undefined)
  if (!seed) return undefined
  const harness = host.harness()
  const state = await harness.snapshot(SeedState, ROOT_CONVERSATION_ID, context)
  const obsoleteUnappliedSeed = state?.applied === undefined && !Array.isArray(seed.learned)
  if (obsoleteUnappliedSeed) {
    host.notice(
      `Chapter ${host.chapter.name} has a seed from an older Ultimate and was not seeded: switch back to ${seed.from.name} with Chapters… and fall asleep again`,
    )
    return undefined
  }
  if (state?.applied === undefined) {
    const ultimate = await host.need(SubagentsApi).standing('ultimate', context)
    await harness.commit(async function seedDocumentsAndEntry(tx) {
      const receipt = await tx.doc(SeedState, ROOT_CONVERSATION_ID)
      if (receipt.applied !== undefined) return
      const memory = await exportedDocument<{
        memories: Record<string, MemoryItem>
      }>(host, tx, 'lineage.memory')
      Object.assign(memory.memories, seed.memories)
      const todos = await exportedDocument<{ next: number; items: Todo[] }>(host, tx, 'todos')
      const carried: Seed['todos'] = [
        ...seed.todos,
        ...seed.scripts
          .filter((item) => item.scope !== 'project' && !item.folder)
          .map(({ id, name, ask, prompt, agent }) => ({
            owner: 'ultimate' as const,
            text: `Recreate script ${id} (${name}): ${ask}${prompt ? ` · prompt: ${prompt}${agent ? ` (agent ${agent})` : ''}` : ''}`,
          })),
        ...seed.automations
          .filter((item) => !portableTrigger(item))
          .map(({ name, schedule, event, condition }) => ({
            owner: 'ultimate' as const,
            text: `Recreate ${schedule ? 'schedule' : event ? 'event' : 'context'} automation (${name}) with new ${condition?.of.startsWith('#') ? 'conversation target' : 'subscribers'}: ${JSON.stringify(schedule ?? event ?? condition)}`,
          })),
      ]
      for (const item of carried) todos.items.push({ ...item, id: todos.next++, at: Date.now() })
      await deliver(host, tx, ultimate, {
        type: 'input',
        requestId: `dream.chapter:${host.chapter.name}`,
        kind: 'dream.chapter',
        data: {
          from: seed.from,
          number: host.chapter.number,
          name: host.chapter.name,
          learned: seed.learned,
          carried: seed.counts,
        },
        content: chapterText(host, seed),
      })
      receipt.applied = Date.now()
    }, context)
  }
  const signal = new AbortController().signal
  const schedulersAfterSeedCommit = seed.automations
  for (const automation of schedulersAfterSeedCommit) {
    if (!portableTrigger(automation)) continue
    const receipt = await harness.snapshot(SeedState, ROOT_CONVERSATION_ID, context)
    const uniqueNameAlreadyRecreated = receipt?.automations.includes(automation.name)
    if (uniqueNameAlreadyRecreated) continue
    await host.invoke(
      'automations',
      'create',
      { ...automation, key: `seed:${host.chapter.name}:${automation.name}` },
      signal,
    )
    await harness.commit(async (tx) => {
      const saved = await tx.doc(SeedState, ROOT_CONVERSATION_ID)
      if (!saved.automations.includes(automation.name)) saved.automations.push(automation.name)
    }, context)
  }
  const branches = await carryBranches(host, seed)
  const conversationOf = (id: ConversationId) => branches[String(id)]
  for (const script of seed.scripts) {
    if (script.scope === 'project' || !script.folder) continue
    if (
      (await harness.snapshot(SeedState, ROOT_CONVERSATION_ID, context))?.scripts?.includes(
        script.id,
      )
    )
      continue
    const subscribers = (script.subscribers ?? []).flatMap((id) => conversationOf(id) ?? [])
    const runsSomething = !!script.prompt || subscribers.length > 0
    if (runsSomething)
      await host
        .invoke(
          'automations',
          'create',
          {
            name: script.name,
            ask: script.ask,
            once: script.once ?? true,
            ...(script.secrets ? { secrets: script.secrets } : {}),
            ...(script.prompt ? { prompt: script.prompt } : {}),
            ...(script.agent ? { agent: script.agent } : {}),
            ...(script.model ? { model: script.model } : {}),
            ...(script.thinking ? { thinking: script.thinking } : {}),
            ...(subscribers.length ? { subscribers } : {}),
            adopt: script.folder,
            key: `seed:${host.chapter.name}:script:${script.id}`,
          },
          signal,
          await host.need(SubagentsApi).standing('ultimate', context),
        )
        .catch((error: unknown) =>
          host.notice(`Chapter seed: script ${script.id} (${script.name}): ${String(error)}`),
        )
    await harness.commit(async (tx) => {
      const saved = await tx.doc(SeedState, ROOT_CONVERSATION_ID)
      saved.scripts = [...new Set([...(saved.scripts ?? []), script.id])]
    }, context)
  }
  for (const question of seed.questions) {
    if (
      (await harness.snapshot(SeedState, ROOT_CONVERSATION_ID, context))?.questions?.includes(
        question.ref,
      )
    )
      continue
    const asker =
      (question.from !== undefined ? conversationOf(question.from) : undefined) ??
      (await host.need(SubagentsApi).standing('ultimate', context))
    await host.need(MessagesApi).send(
      asker,
      {
        to: 'user',
        reply: true,
        text: `Asked before the new chapter (${seed.from.name}${question.ref}), still open:\n\n${question.text}`,
        ...(question.questions ? { questions: question.questions } : {}),
      },
      `seed:${host.chapter.name}:question:${question.ref}`,
      context,
    )
    await harness.commit(async (tx) => {
      const saved = await tx.doc(SeedState, ROOT_CONVERSATION_ID)
      saved.questions = [...new Set([...(saved.questions ?? []), question.ref])]
    }, context)
  }
  harness.resume()
  return seed
}

function carriedPrompt(seed: Seed, branch: Seed['branches'][number]) {
  const { from } = seed
  return [
    `You continue ${from.name}#${branch.id} « ${branch.title} » from Chapter ${from.number} · ${from.name}, which the project left for a new chapter. That conversation stays on disk: read it with codemode \`ultimate.entries(${branch.id}, { chapter: '${from.name}' })\` and \`ultimate.search(text, { chapter: '${from.name}' })\` before acting.`,
    ...(branch.abstract ? ['', 'Its last abstract:', branch.abstract] : []),
    ...(branch.git
      ? [
          '',
          `Its work was on git branch \`${branch.git}\`: switch your workspace to it (\`git switch ${branch.git}\`, or merge it) before you change anything.`,
        ]
      : []),
    '',
    'Automations that woke it now wake you, and its open questions to the user are asked again from here. Pick up where it left off; if nothing is left to do, say so in one line and stop.',
  ].join('\n')
}

async function carryBranches(host: ExtensionHost, seed: Seed) {
  const harness = host.harness()
  const lineage = host.need(LineageApi)
  for (const branch of seed.branches ?? []) {
    const receipt = await harness.snapshot(SeedState, ROOT_CONVERSATION_ID, context)
    if (receipt?.branches?.[String(branch.id)] !== undefined) continue
    const prompt = carriedPrompt(seed, branch)
    const forkCommittedBeforeItsReceipt = await harness.commit(async (tx) => {
      let cursor
      do {
        const page = await tx.scanConversations({}, 100, cursor)
        for (const record of page.items)
          if ((await tx.doc(Branch, record.id)).branch?.intent === prompt) return record.id
        cursor = page.next
      } while (cursor)
      return undefined
    }, context)
    const root =
      (await harness.snapshot(Roots, ROOT_CONVERSATION_ID, context))?.roots[0] ??
      ROOT_CONVERSATION_ID
    const { id } =
      forkCommittedBeforeItsReceipt !== undefined
        ? { id: forkCommittedBeforeItsReceipt }
        : await lineage.branch(
            {
              from: root,
              prompt,
              title: branch.title.slice(0, 60),
              isolated: branch.git !== undefined,
              ...(branch.model ? { model: branch.model } : {}),
              ...(branch.thinking ? { thinkingLevel: branch.thinking } : {}),
              deliver: false,
            },
            context,
          )
    await harness.commit(async (tx) => {
      const saved = await tx.doc(SeedState, ROOT_CONVERSATION_ID)
      saved.branches ??= {}
      if (saved.branches[String(branch.id)] !== undefined) return
      saved.branches[String(branch.id)] = id
      if (branch.instructions) await configure(tx, id, { instructions: branch.instructions })
      if (branch.label) (await tx.doc(host.metadata, id)).label = branch.label
      await deliver(host, tx, id, {
        type: 'input',
        requestId: `dream.carried:${host.chapter.name}:${branch.id}`,
        kind: 'dream.carried',
        data: { from: seed.from, conversation: branch.id, title: branch.title },
        content: prompt,
      })
    }, context)
  }
  return (await harness.snapshot(SeedState, ROOT_CONVERSATION_ID, context))?.branches ?? {}
}
