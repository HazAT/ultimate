/** The `branch` tool: start a lineage branch and send it its first message. */
import { Type } from '@earendil-works/pi-ai'
import { configure, defineTool, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { definitionAgent, discoverAgents, hostDefaultModel } from '../../lib/agents.ts'
import { LineageApi, Roots } from '../lineage/api.ts'
import { actingAs } from '../../lib/acting-as.ts'
import { imagesParameter } from './images.ts'
import { send } from './send.ts'
import { Started } from './addresses.ts'

export const branchTool = (host: ExtensionHost) =>
  defineTool({
    name: 'branch',
    deferred: true,
    description:
      "Start a lineage branch. Its answer returns to you as a reply. Give it a title: one short line naming the work (at most 60 characters), shown in the sidebar and the tally until its summary renames it; without one, the prompt's first 80 characters name it.",
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1 }),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
      root: Type.Optional(Type.Number()),
      isolated: Type.Optional(Type.Boolean()),
      images: Type.Optional(imagesParameter),
    }),
    // Lineage atomically deduplicates the fork; Sent deduplicates its first message.
    replay: 'safe',
    async execute(input, api, ctx) {
      const from = await actingAs(host, api.conversationId, ctx)
      let id = await api.memo<number>('branch-id', ctx)
      if (id === undefined) {
        const lineage = host.need(LineageApi)
        const roots = (await host.harness().snapshot(Roots, ROOT_CONVERSATION_ID, ctx))?.roots ?? []
        const root =
          input.root ??
          (await lineage.rootOf(api.conversationId, ctx)) ??
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
        const coordinator = definitions.find((definition) => definition.name === 'coordinator')
        if (!coordinator) throw new Error('Missing coordinator definition')
        // The model and thinking level the definition pins when its provider has a login here, thinking clamped to
        // what the model supports; without one, the current default model, never the one the root last stored.
        const rootAgent = await (await host
          .harness()
          .conversation(root as ConversationId, ctx))!.agent(ctx)
        const { model, thinkingLevel, modelTools } = definitionAgent(
          coordinator,
          { ...rootAgent, model: await hostDefaultModel(host) },
          host.modelRuntime,
        )
        const branch = await lineage.branch(
          {
            from: root,
            prompt: input.prompt,
            ...(input.title ? { title: input.title } : {}),
            isolated: input.isolated ?? true,
            deliver: false,
            by: from,
            receipt: { taskId: api.taskId, callId: api.callId },
            ...(model ? { model } : {}),
            ...(thinkingLevel ? { thinkingLevel } : {}),
          },
          ctx,
        )
        // The fork has no input yet. Its instructions come from the definition; its tools stay inherited, plus the
        // deferred ones the definition names (an overlay's `addTools: [debug]`).
        await host.harness().commit(async (tx) => {
          await configure(tx, branch.id, {
            instructions: coordinator.instructions,
            ...(modelTools && 'add' in modelTools && modelTools.add?.length ? { modelTools } : {}),
          })
          ;(await tx.doc(host.metadata, branch.id)).label = 'coordinator'
          ;(await tx.doc(Started, branch.id)).by = from
        }, ctx)
        id = await api.memo('branch-id', branch.id, ctx)
      }
      const message = await send(
        host,
        from,
        {
          to: `#${id}`,
          text: input.prompt,
          reply: true,
          ...(input.images === undefined ? {} : { images: input.images }),
          imagesFrom: api.conversationId,
        },
        ctx,
        { taskId: api.taskId, callId: api.callId },
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
