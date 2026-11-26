import { parseEntryId, parseConversationId } from '../../lib/ids.ts'
import type { Context } from '@earendil-works/chord/context'
import type { ConversationId, TaskId } from '@earendil-works/pi-durable'
import { bool, num, obj, opt, str } from '@earendil-works/pi-schema'
import { configure, defineTool, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import {
  definitionAgent,
  definitionFamily,
  discoverAgents,
  hostDefault,
  onFamily,
} from '../../lib/agents.ts'
import { Family } from '../models/api.ts'
import { readFamilies } from '../../lib/families-settings.ts'
import { LineageApi, Roots } from '../lineage/api.ts'
import { actingAs } from '../../lib/acting-as.ts'
import { imagesParameter, resolveImages } from './images.ts'
import type { ImagesRef } from './images.ts'
import { send } from './send.ts'
import { parentOf, Started } from './addresses.ts'
import { safeToRerun } from '../../lib/replay.ts'

export async function createCoordinatorBranch(
  host: ExtensionHost,
  from: ConversationId,
  input: {
    prompt: string
    title?: string
    root?: ConversationId
    family?: string
    isolated?: boolean
  },
  ctx: Context,
  options: {
    callerConversationId?: ConversationId
    receipt?: { taskId: TaskId; callId: string }
  } = {},
) {
  const parent = await parentOf(host, from, ctx)
  if (parent !== undefined)
    throw new Error(`A subagent starts no branch: give your final answer, or message #${parent}.`)
  const lineage = host.need(LineageApi)
  const roots = (await host.harness().snapshot(Roots, ROOT_CONVERSATION_ID, ctx))?.roots ?? [
    ROOT_CONVERSATION_ID,
  ]
  const root =
    input.root ??
    (await lineage.rootOf(options.callerConversationId ?? from, ctx)) ??
    (roots.length === 1 ? roots[0] : undefined)
  if (root === undefined || !roots.includes(root))
    throw new Error(
      `Choose a root. Roots: ${roots.map((candidate) => `#${candidate}`).join(', ') || '(none)'}`,
    )
  const { definitions } = await discoverAgents(
    host.ultimateRoot,
    host.projectRoot,
    host.userHome,
    host.modelRuntime,
  )
  const definition = definitions.find((candidate) => candidate.name === 'coordinator')
  if (!definition) throw new Error('Missing coordinator definition')
  const coordinator =
    input.family === undefined
      ? definition
      : onFamily(
          definition,
          input.family,
          await readFamilies(host.userHome, host.projectRoot),
          host.modelRuntime.getAvailableSnapshot(),
        )

  const inheritedRootAgent = await (await host.harness().conversation(root, ctx))!.agent(ctx)
  const authenticatedOrDefaultAgent = definitionAgent(
    coordinator,
    { ...inheritedRootAgent, ...(await hostDefault(host)) },
    host.modelRuntime,
  )
  const { model, thinkingLevel, modelTools, tools } = authenticatedOrDefaultAgent
  const branch = await lineage.branch(
    {
      from: root,
      prompt: input.prompt,
      ...(input.title ? { title: input.title } : {}),
      isolated: input.isolated ?? true,
      deliver: false,
      by: from,
      ...(options.receipt ? { receipt: options.receipt } : {}),
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    },
    ctx,
  )

  await host.harness().commit(async (tx) => {
    await configure(tx, branch.id, {
      instructions: coordinator.instructions,
      ...(modelTools && 'add' in modelTools && modelTools.add?.length ? { modelTools } : {}),
      ...(coordinator.tools || coordinator.denyTools?.length ? { tools } : {}),
    })
    ;(await tx.doc(host.metadata, branch.id)).label = 'coordinator'
    ;(await tx.doc(Family, branch.id)).name = definitionFamily(
      coordinator,
      authenticatedOrDefaultAgent,
    )
    const started = await tx.doc(Started, branch.id)
    started.by = from
  }, ctx)
  return branch.id
}

export async function startBranch(
  host: ExtensionHost,
  from: ConversationId,
  input: {
    prompt: string
    title?: string
    root?: ConversationId
    family?: string
    isolated?: boolean
  },
  requestId: string,
  ctx: Context,
) {
  const id = await createCoordinatorBranch(host, from, input, ctx)
  const message = await send(host, from, { to: `#${id}`, text: input.prompt, reply: true }, ctx, {
    requestId,
  })
  return { id, message }
}

export const branchTool = (host: ExtensionHost) =>
  defineTool({
    name: 'branch',
    deferred: true,
    description:
      "Start a lineage branch. Its answer returns to you as a reply. Give it a title: one short line naming the work (at most 60 characters), shown in the sidebar and the tally until its summary renames it; without one, the prompt's first 80 characters name it. family names a model family the coordinator runs on instead of its own.",
    parameters: obj({
      prompt: str({ minLength: 1 }),
      title: opt(str({ minLength: 1, maxLength: 60 })),
      root: opt(num()),
      family: opt(str({ minLength: 1 })),
      isolated: opt(bool()),
      images: opt(imagesParameter),
    }),
    ...safeToRerun(
      'Lineage atomically deduplicates the fork; Sent deduplicates its first message.',
    ),
    async execute(input, api, ctx) {
      const from = await actingAs(host, api.conversationId, ctx)
      let id = await api.memo<number>('branch-id', ctx)
      let images: ImagesRef | undefined =
        typeof input.images === 'number' ? parseEntryId(input.images) : input.images
      if (id === undefined) {
        const ref = images
        if (ref !== undefined)
          images = (
            await host.harness().commit((tx) => resolveImages(tx, api.conversationId, ref), ctx)
          ).entry
        const created = await createCoordinatorBranch(
          host,
          from,
          {
            prompt: input.prompt,
            ...(input.title ? { title: input.title } : {}),
            ...(input.root === undefined ? {} : { root: parseConversationId(input.root) }),
            ...(input.family === undefined ? {} : { family: input.family }),
            ...(input.isolated === undefined ? {} : { isolated: input.isolated }),
          },
          ctx,
          {
            callerConversationId: api.conversationId,
            receipt: { taskId: api.taskId, callId: api.callId },
          },
        )
        id = await api.memo('branch-id', created, ctx)
      }
      const message = await send(
        host,
        from,
        {
          to: `#${id}`,
          text: input.prompt,
          reply: true,
          ...(images === undefined ? {} : { images }),
          imagesFrom: api.conversationId,
        },
        ctx,
        {
          taskId: api.taskId,
          callId: api.callId,
          ...(from === api.conversationId ? { serveBranch: true } : {}),
        },
      )
      if (from !== api.conversationId)
        await host
          .need(LineageApi)
          .leaveNote(
            from,
            `Side chat #${api.conversationId} started branch #${id}: ${input.prompt.split('\n')[0].slice(0, 160)}`,
            {
              from: api.conversationId,
              requestId: `sidechat:branch:${api.taskId}:${api.callId}`,
            },
          )
      return {
        output: [
          {
            type: 'text',
            text: `Branch #${id} started; message ${message} sent.`,
          },
        ],
      }
    },
  })
