import type { JSX } from '@solidjs/web'
import { For, Show } from 'solid-js'

import { elidePath, shortenPath, useConversation, useModels, useSystem } from '../sdk/hooks.ts'

export function EmptyState() {
  const system = useSystem()
  const conversation = useConversation()
  const agent = () => conversation().agent
  const models = useModels()
  const reasoning = () =>
    models()?.models.find(
      (model) => model.provider === agent().model?.provider && model.id === agent().model?.modelId,
    )?.reasoning
  const cwd = () => agent().cwd ?? system()?.execution.defaultCwd ?? ''
  const rows: { label: string; value: JSX.Element }[] = [
    {
      label: 'repo',
      value: (
        <>
          {elidePath(shortenPath(cwd(), { home: system()?.machine.home }), 44)}
          <Show when={system()?.code.branch && cwd() === system()?.code.ultimateRoot}>
            <span class="text-muted-foreground"> ({system()?.code.branch})</span>
          </Show>
        </>
      ),
    },
    {
      label: 'model',
      value: (
        <Show when={agent().model} fallback={<span class="text-warning">none configured</span>}>
          {(model) =>
            `${model().provider}/${model().modelId}${reasoning() !== false && agent().thinkingLevel ? ` · ${agent().thinkingLevel}` : ''}`
          }
        </Show>
      ),
    },
    {
      label: 'ext',
      value: (
        <>
          {system()
            ? `${system()!.extensions.filter((extension) => extension.enabled).length} enabled`
            : '…'}
        </>
      ),
    },
    {
      label: 'host',
      value: (
        <>
          {system()
            ? `${system()!.machine.hostname} · ${system()!.process.node} · gen ${system()!.process.generation}`
            : '…'}
        </>
      ),
    },
  ]
  return (
    <div class="flex size-full min-h-[55vh] flex-col items-center justify-center gap-3 p-8 text-center">
      <div class="w-full max-w-md font-mono text-[12px]" data-ui="empty-state">
        <div class="text-[13px] font-semibold tracking-[0.3em] text-brand" data-ui="wordmark">
          ULTIMATE
        </div>
        <div class="mt-1 font-sans text-[13px] text-muted-foreground">
          {!system() || system()!.project.root === system()!.code.ultimateRoot
            ? 'A coding agent that edits this repository, itself included.'
            : `A coding agent that edits ${system()!.project.name}, and can change itself too.`}
        </div>
        <div class="mt-5 grid grid-cols-[4rem_1fr] gap-x-3 gap-y-1 border-t border-border/70 pt-4 text-left">
          <For each={rows}>
            {(row) => (
              <>
                <span class="text-muted-foreground/70">{row.label}</span>
                <span class="truncate text-foreground/85">{row.value}</span>
              </>
            )}
          </For>
        </div>
      </div>
    </div>
  )
}
