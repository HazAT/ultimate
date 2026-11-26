import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { readJson, writeJson } from '../../lib/json-file.ts'
import { openQuestion } from '../../lib/message-state.ts'
import { Standing, SubagentsApi } from '../subagents/api.ts'
import type { MemoryItem } from '../lineage/refs.ts'
import { TodosApi } from '../todos/api.ts'
import { Memory, Roots } from '../lineage/api.ts'
import { Messages } from '../messages/api.ts'
import type { Automation } from '../automations/types.ts'
import { BuiltInDoc, PauseDoc } from './built-ins.ts'
import type { Prepared } from './refs.ts'
import type { Seed } from './types.ts'
import { checkpointEvery } from '../../shared/checkpoint.ts'

export const SeedState = defineDoc<{ applied?: number; automations: string[] }>({
  kind: 'dream.seed',
  checkpointWhen: checkpointEvery(100),
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

const prototypeFreeMemoryIndex = () => Object.create(null) as Record<string, MemoryItem>
const detachTransactionOverlays = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
export async function buildSeed(host: ExtensionHost, prepared: Prepared): Promise<Seed> {
  const signal = new AbortController().signal
  const automations = (await host.invoke('automations', 'list', null, signal)) as Automation[]
  return host.harness().commit(async (tx) => {
    const roots = (await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots
    const memories = prototypeFreeMemoryIndex()
    const about = new Set<string>()
    for (const root of roots) {
      const source = await tx.doc(Memory, root)
      for (const [slug, memory] of Object.entries(source.memories)) {
        if (slug.startsWith('about-')) about.add(slug)
        if (!memories[slug] || memory.updated > memories[slug].updated) memories[slug] = memory
      }
    }
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
    const todos = (await host.want(TodosApi)?.listOpen(tx)) ?? []
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
    return detachTransactionOverlays({
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
    const ultimate = (await harness.conversation(
      await host.need(SubagentsApi).standing('ultimate', context),
      context,
    ))!
    await harness.commit(async function seedDocumentsAndEntry(tx) {
      const receipt = await tx.doc(SeedState, ROOT_CONVERSATION_ID)
      if (receipt.applied !== undefined) return
      const memory = await tx.doc(Memory, ROOT_CONVERSATION_ID)
      Object.assign(memory.memories, seed.memories)
      const todos = host.want(TodosApi)
      if (todos) {
        const carried: Seed['todos'] = [
          ...seed.todos,
          ...seed.questions.map(({ ref, text }) => ({
            owner: 'user' as const,
            text: `Open question (${seed.from.name}${ref}): ${text}`,
          })),
          ...seed.scripts
            .filter((item) => item.scope !== 'project')
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
        for (const item of carried) await todos.addCarried(tx, item)
      }
      await ultimate.submit(tx, {
        type: 'input',
        requestId: `dream.chapter:${host.chapter.name}`,
        content: chapterText(host, seed),
        entry: {
          kind: 'dream.chapter',
          data: {
            from: seed.from,
            number: host.chapter.number,
            name: host.chapter.name,
            learned: seed.learned,
            carried: seed.counts,
          },
        },
        whenBusy: 'followUp',
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
  harness.resume()
  return seed
}
