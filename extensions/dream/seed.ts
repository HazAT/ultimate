import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { readJson, writeJson } from '../../lib/json-file.ts'
import { openQuestion } from '../../lib/message-state.ts'
import { Standing, SubagentsApi } from '../subagents/api.ts'
import type { MemoryItem } from '../lineage/refs.ts'
import type { Todo } from '../todos/refs.ts'
import { Roots } from '../lineage/api.ts'
import { Messages } from '../messages/api.ts'
import type { Automation } from '../automations/types.ts'
import { BuiltInDoc, PauseDoc } from './built-ins.ts'
import { deliver } from './delivery.ts'
import type { Prepared } from './refs.ts'
import type { Seed } from './types.ts'

/** Application and automation receipts on conversation 1; the seed file itself stays on disk. */
export const SeedState = defineDoc<{ applied?: number; automations: string[] }>({
  kind: 'dream.seed',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ automations: [] }),
})

/**
 * Whether a seeded trigger is made again in the new chapter: it has a prompt run or a standing agent to wake, and does
 * not watch a numbered conversation, which does not exist there. Others become to-dos to recreate by hand.
 */
const carries = (item: Seed['automations'][number]) =>
  (!!item.prompt || !!item.subscribers?.length) && !item.condition?.of.startsWith('#')

/** Exported conversation documents are resolved at call time, including after a facet reload. */
async function document<T>(host: ExtensionHost, tx: Tx, kind: string, id = 1): Promise<T> {
  const token = host.doc(kind)
  if (!token) throw new Error(`Chapter seed needs document ${kind}`)
  return (await tx.doc(token, id as ConversationId)) as unknown as T
}

/** Read what @ultimate `prepared` and the project context without importing another facet's implementation. */
export async function buildSeed(host: ExtensionHost, prepared: Prepared): Promise<Seed> {
  const signal = new AbortController().signal
  // These ledgers are session-scoped, not exported conversation docs; their list actions read them.
  const automations = (await host.invoke('automations', 'list', null, signal)) as Automation[]
  return host.harness().commit(async (tx) => {
    const roots = (await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots
    // A null prototype: `constructor` and the like are valid memory slugs.
    const memories = Object.create(null) as Record<string, MemoryItem>
    const about = new Set<string>()
    for (const root of roots) {
      const source = await document<{ memories: Record<string, MemoryItem> }>(
        host,
        tx,
        'lineage.memory',
        root,
      )
      for (const [slug, memory] of Object.entries(source.memories)) {
        if (slug.startsWith('about-')) about.add(slug)
        if (!memories[slug] || memory.updated > memories[slug].updated) memories[slug] = memory
      }
    }
    // Open questions are the user's unanswered messages, as the To-dos panel lists them: the questions each asks, or
    // the message itself when it asks none.
    const questions: Seed['questions'] = []
    for (const message of (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages) {
      if (!openQuestion(message)) continue
      const ref = `#${message.id}`
      if (message.questions?.length)
        for (const { text } of message.questions) questions.push({ text, ref })
      else questions.push({ text: message.text, ref })
    }
    for (const slug of about)
      if (!memories[slug]) throw new Error(`Chapter seed lost user memory ${slug}`)
    const todos = (await document<{ items: Todo[] }>(host, tx, 'todos')).items
      .filter((item) => item.done === undefined)
      .map(({ text, owner }) => ({ text, owner }))
    // The built-in dream triggers are dream's own: the new chapter makes them again, as they were here.
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
        // A standing agent's @name means the same in the new chapter; a #id does not exist there.
        const subscribers = item.subscribers.filter((s): s is string => typeof s === 'string')
        return {
          name,
          prompt,
          ...(subscribers.length ? { subscribers } : {}),
          ...(item.schedule ? { schedule: item.schedule } : {}),
          ...(item.event
            ? {
                event: {
                  name: item.event.name,
                  ...(item.event.where ? { where: item.event.where } : {}),
                },
              }
            : {}),
          ...(item.condition
            ? {
                condition: {
                  metric: item.condition.metric,
                  of: item.condition.of,
                  above: item.condition.above,
                  cooldownMs: item.condition.cooldownMs,
                  ...(item.condition.idleFor ? { idleFor: item.condition.idleFor } : {}),
                },
              }
            : {}),
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
    const watchers = automations
      .filter((item) => item.enabled && item.script)
      .map(({ id, scope, name, script, prompt, agent, model, thinking }) => ({
        id,
        ...(scope ? { scope } : {}),
        name,
        ask: script!.ask,
        ...(prompt ? { prompt } : {}),
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
        ...(thinking ? { thinking } : {}),
      }))
    // Materialize document overlays before the transaction releases them.
    return JSON.parse(
      JSON.stringify({
        from: { name: host.chapter.name, number: host.chapter.number },
        learned: prepared.learned,
        memories,
        todos,
        questions,
        automations: triggers,
        scripts: watchers,
        counts: {
          memories: Object.keys(memories).length,
          todos: todos.length,
          questions: questions.length,
          automations: triggers.length,
          scripts: watchers.length,
        },
        builtIn: builtIn ? { enabled: builtIn.enabled } : null,
        builtInPause: builtInPause ? { enabled: builtInPause.enabled } : null,
        continues: { conversation: ultimate, handoff: prepared.handoff },
      }),
    ) as Seed
  }, context)
}

/** Publish a complete seed atomically in the destination chapter's directory. */
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

/**
 * Apply documents and schedule the chapter entry atomically; reconcile scheduler effects after that commit. Returns the
 * chapter's seed, if it has one.
 */
export async function applySeed(host: ExtensionHost) {
  const seed = await readJson<Seed | undefined>(join(host.chapter.dir, 'seed.json'), undefined)
  if (!seed) return undefined
  const harness = host.harness()
  const state = await harness.snapshot(SeedState, ROOT_CONVERSATION_ID, context)
  // A seed an older Ultimate wrote just before the restart that brought this code: the chapter opens empty, and the
  // one it came from is as it was left, so the user goes back and falls asleep again.
  if (state?.applied === undefined && !Array.isArray(seed.learned)) {
    host.notice(
      `Chapter ${host.chapter.name} has a seed from an older Ultimate and was not seeded: switch back to ${seed.from.name} with Chapters… and fall asleep again`,
    )
    return undefined
  }
  if (state?.applied === undefined) {
    const ultimate = await host.need(SubagentsApi).standing('ultimate', context)
    await harness.commit(async (tx) => {
      const receipt = await tx.doc(SeedState, ROOT_CONVERSATION_ID)
      if (receipt.applied !== undefined) return
      const memory = await document<{ memories: Record<string, MemoryItem> }>(
        host,
        tx,
        'lineage.memory',
      )
      Object.assign(memory.memories, seed.memories)
      const todos = await document<{ next: number; items: Todo[] }>(host, tx, 'todos')
      const carried: Seed['todos'] = [
        ...seed.todos,
        ...seed.questions.map(({ ref, text }) => ({
          owner: 'user' as const,
          text: `Open question (${seed.from.name}${ref}): ${text}`,
        })),
        // Project manifests are rediscovered by automations onOpen; user scripts need recreating.
        ...seed.scripts
          .filter((item) => item.scope !== 'project')
          .map(({ id, name, ask, prompt, agent }) => ({
            owner: 'ultimate' as const,
            text: `Recreate script ${id} (${name}): ${ask}${prompt ? ` · prompt: ${prompt}${agent ? ` (agent ${agent})` : ''}` : ''}`,
          })),
        ...seed.automations
          .filter((item) => !carries(item))
          .map(({ name, schedule, event, condition }) => ({
            owner: 'ultimate' as const,
            text: `Recreate ${schedule ? 'schedule' : event ? 'event' : 'context'} automation (${name}) with new ${condition?.of.startsWith('#') ? 'conversation target' : 'subscribers'}: ${JSON.stringify(schedule ?? event ?? condition)}`,
          })),
      ]
      for (const item of carried) todos.items.push({ ...item, id: todos.next++, at: Date.now() })
      // It wakes @ultimate: its first turn is what the wake-up side chat forks from.
      await deliver(host, tx, ultimate, {
        type: 'input',
        requestId: `dream.chapter:${host.chapter.name}`,
        kind: 'dream.chapter',
        // The morning card shows where we came from and what came along; the old chapter's documents stay there.
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
  for (const automation of seed.automations) {
    if (!carries(automation)) continue
    const receipt = await harness.snapshot(SeedState, ROOT_CONVERSATION_ID, context)
    if (receipt?.automations.includes(automation.name)) continue
    // Names are unique in a seed: a create whose receipt was lost gets its automation back from the key.
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
  harness.resume()
  return seed
}
