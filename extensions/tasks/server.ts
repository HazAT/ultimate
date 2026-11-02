import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { AssistantEntry } from '@earendil-works/pi-durable'
import type { EntryId, TaskId, Tx } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { AutomationsApi } from '../automations/api.ts'
import type { Message } from '../messages/api.ts'
import { DescribeAction, StartedAction } from './refs.ts'
import type { TaskFacts } from './refs.ts'

type Input = Record<string, unknown> | null | undefined
/** The message's opening words, lines joined: a first line alone is often only "The user's go:". */
const gist = (text: string) => {
  const words = text.replace(/\s+/g, ' ').trim()
  return words.length > 100 ? `${words.slice(0, 99)}…` : words
}

/** The conversation a task's input names, under whichever field its kind uses. */
const conversationOf = (input: Input) => {
  for (const key of ['conversationId', 'conversation', 'target', 'id', 'to'])
    if (typeof input?.[key] === 'number') return input[key]
  return undefined
}

/** What one task's input says about it; see `TaskFacts`. */
async function facts(host: ExtensionHost, tx: Tx, kind: string, input: Input): Promise<TaskFacts> {
  switch (kind) {
    case 'board.delivery': {
      // In its `reply` phase it carries the recipient's answer back to this message's sender.
      const m = input?.message as Message
      return {
        message: {
          id: m.id,
          from: m.from,
          to: m.to,
          reply: m.reply,
          note: input?.note === true,
          gist: gist(m.text),
        },
      }
    }
    case 'pi.tool': {
      const call = input?.call as { name?: string } | undefined
      if (call?.name) return { tool: call.name }
      const entry = await tx.entry(AssistantEntry, input?.assistant as EntryId)
      const message = entry?.model?.[0]
      const part =
        message?.role === 'assistant'
          ? message.content.find((item) => item.type === 'toolCall' && item.id === input?.callId)
          : undefined
      return part?.type === 'toolCall' ? { tool: part.name } : {}
    }
    case 'ultimate.automation-scheduler': {
      const a = await host.want(AutomationsApi)?.read(tx, input?.id as string)
      return a ? { automation: a.name } : {}
    }
    case 'ultimate.automation-run':
      return { automation: (input!.automation as { name: string }).name }
    case 'ultimate.automation-delivery':
      return { automation: (input!.sub as { name: string }).name }
    // Which submission it lands changes as it works the queue; the panel reads that from the live queue.
    case 'workspaces.lander':
      return { source: input?.source as string }
    default: {
      const conversation = conversationOf(input)
      return conversation === undefined ? {} : { conversation }
    }
  }
}

export default { name: 'tasks' }

export const actions = {
  /** When each of `ids` first ran, in wall-clock milliseconds; tasks not yet started or gone are left out. */
  started: implementAction(StartedAction, async (args, { host }) => {
    const ids = (args as { ids?: unknown } | null)?.ids
    if (!Array.isArray(ids) || !ids.every((id) => Number.isSafeInteger(id)))
      throw new Error('Expected task ids')
    return host.harness().commit(async (tx) => {
      const started: Record<string, number> = {}
      for (const id of ids as number[]) {
        const at = (await tx.task(id as TaskId))?.startedAt
        if (at !== undefined) started[id] = at
      }
      return started
    }, context)
  }),
  /** What the input of each of `ids` says about it, to name it in plain words; gone tasks are left out. */
  describe: implementAction(DescribeAction, async (args, { host }) => {
    const ids = (args as { ids?: unknown } | null)?.ids
    if (!Array.isArray(ids) || !ids.every((id) => Number.isSafeInteger(id)))
      throw new Error('Expected task ids')
    return host.harness().commit(async (tx) => {
      const described: Record<string, TaskFacts> = {}
      for (const id of ids as number[]) {
        const task = await tx.task(id as TaskId)
        if (task) described[id] = await facts(host, tx, task.kind, task.input as Input)
      }
      return described
    }, context)
  }),
}
