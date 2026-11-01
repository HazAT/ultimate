import { realpath } from 'node:fs/promises'
import { awaitWithContext } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import type { ToolExecutionResult } from '@earendil-works/pi-durable'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { WorkspacesApi } from '../workspaces/api.ts'

export default function self(host: ExtensionHost) {
  // Core, always on; the handle resolves the current provider at each call.
  const workspaces = host.need(WorkspacesApi)
  return defineExtension({
    name: 'self',
    sections: [
      section('self', async (input, context) => {
        const own = await workspaces.get(input.conversationId, context)
        const sourceRoot =
          own && host.projectRoot === host.ultimateRoot ? own.path : host.ultimateRoot
        return [
          ...(host.projectRoot === host.ultimateRoot
            ? ['The host project is Ultimate itself.']
            : []),
          `When someone is new to Ultimate or asks how it works, guide them from ${sourceRoot}/README.md (what it is, how to start, what to try) and the "How work is organised" section of ${sourceRoot}/AGENTS.md (roots, branches, notes, landing): explain briefly, in their terms, and point at the UI they will use (@ultimate's row at the top of the sidebar, or the top-bar @ultimate button on phones, and its conversation, Ctrl+K or ⌘K commands, the right panel).`,
          `Before changing Ultimate, read ${sourceRoot}/AGENTS.md (layers, reloads, durability) and ${sourceRoot}/extensions/README.md (new UI is a new extension folder).`,
          'UI and extension changes in the running host reload live. Call restart only after editing server/ or shared/, never for web/, extensions/, or agents/.',
          ...(own
            ? [
                `Land your workspace into ${own.source} first; restart requires the running clone to be clean at that landed commit.`,
              ]
            : []),
        ].join('\n')
      }),
    ],
    tools: [
      defineTool({
        name: 'restart',
        description:
          'Restart the shared Ultimate host after authorized changes to server/ or shared/. Land an isolated workspace into the running clone first.',
        parameters: Type.Object({}),
        // The target generation is memoized before the swap, so replay reports it without restarting again.
        replay: 'safe',
        async execute(_args, api, context): Promise<ToolExecutionResult> {
          const own = await workspaces.get(api.conversationId, context)
          if (
            own &&
            ((await realpath(own.source)) !== (await realpath(host.ultimateRoot)) ||
              !own.landed ||
              (await workspaces.git(host.ultimateRoot, 'status', '--porcelain')) ||
              (await workspaces.git(host.ultimateRoot, 'rev-parse', 'HEAD')) !== own.landed)
          ) {
            const error = `Restart refused: land your workspace into ${own.source} first`
            return {
              isError: true,
              details: { refused: true, error },
              output: [{ type: 'text', text: error }],
            }
          }
          const key = `restart:${api.taskId}`
          const done = await api.memo<{
            generation: number
            fromGeneration: number
            build: string
          }>(key, context)
          if (done && Number(process.env.ULTIMATE_GENERATION) !== done.generation)
            return {
              isError: true,
              details: {
                fromGeneration: done.fromGeneration,
                toGeneration: Number(process.env.ULTIMATE_GENERATION),
                fromBuild: done.build,
                toBuild: host.build().id,
                rolledBack: true,
                error: host.system().process.activationError ?? 'Activation failed',
              },
              output: [
                {
                  type: 'text',
                  text: `Restart failed during activation; rolled back to generation ${process.env.ULTIMATE_GENERATION}. ${host.system().process.activationError ?? ''}`,
                },
              ],
            }
          if (done)
            return {
              details: {
                fromGeneration: done.fromGeneration,
                toGeneration: done.generation,
                fromBuild: done.build,
                toBuild: host.build().id,
              },
              output: [
                {
                  type: 'text',
                  text: `Restarted. Now running generation ${process.env.ULTIMATE_GENERATION ?? done.generation} (pid ${process.pid}), build ${done.build} → ${host.build().id}.`,
                },
              ],
            }
          const error = await awaitWithContext(
            host.restart(async (generation) => {
              await api.memo(
                key,
                {
                  generation,
                  fromGeneration: Number(process.env.ULTIMATE_GENERATION ?? 1),
                  build: host.build().id,
                },
                context,
              )
            }),
            context,
          )
          return {
            isError: true,
            details: {
              fromGeneration: Number(process.env.ULTIMATE_GENERATION ?? 1),
              toGeneration: Number(process.env.ULTIMATE_GENERATION ?? 1),
              fromBuild: host.build().id,
              toBuild: host.build().id,
              error,
            },
            output: [{ type: 'text', text: error }],
          }
        },
      }),
    ],
  })
}
