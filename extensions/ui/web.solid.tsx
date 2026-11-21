/** @jsxImportSource @solidjs/web */
import type { JsonValue } from '@earendil-works/chord/json'
import { For, Show } from 'solid-js'
import { cn, defineWebExtension, formatTime, provide, useEvents } from '@/sdk/solid'
import { ChangedEvent } from '../../shared/events.ts'
import { SystemTab } from '../system/ui.solid.tsx'

type VersionOne = { component?: string; label?: string; driven?: boolean }

const shown = (value: JsonValue | undefined) =>
  value === undefined ? 'unset' : typeof value === 'string' ? value : JSON.stringify(value)

function Changes() {
  const changes = useEvents({ events: [ChangedEvent], limit: 100 })
  return (
    <div class="min-h-0 flex-1 overflow-y-auto">
      <ul class="flex flex-col py-1">
        <For each={changes()} keyed={(change) => change.id}>
          {(change) => {
            const data = () => change().data
            const recordedByTheBrowser = () =>
              change().v === 1 ? (data() as VersionOne) : undefined
            const agent = () => data().source === 'agent' || recordedByTheBrowser()?.driven === true
            const who = () =>
              agent() ? 'agent' : `person${data().device ? ` · ${data().device}` : ''}`
            return (
              <li
                class="flex min-w-0 items-start gap-1.5 px-3 py-[3px] font-mono text-[10.5px] leading-[18px] text-muted-foreground hover:bg-muted/40 pointer-coarse:py-1.5"
                data-change={change().id}
                title={`${data().source}${data().device ? ` · ${data().device}` : ''}${data().login ? ` · ${data().login}` : ''}${data().conversation === undefined ? '' : ` · #${data().conversation}`}`}
              >
                <time
                  class="w-14 shrink-0 tabular-nums text-muted-foreground/60"
                  datetime={change().at}
                >
                  {formatTime(change().at, true)}
                </time>
                <span
                  class={cn(
                    'w-28 shrink-0 truncate',
                    agent() ? 'text-brand' : 'text-foreground/70',
                  )}
                >
                  {who()}
                </span>
                <Show
                  when={recordedByTheBrowser()}
                  fallback={
                    <span class="min-w-0 shrink-0 truncate text-foreground/85 md:max-w-72">
                      {data().key}
                    </span>
                  }
                >
                  {(browser) => (
                    <>
                      <span class="min-w-0 shrink-0 truncate font-sans text-[11px] text-foreground/85 md:max-w-56">
                        {browser().label ?? browser().component}
                      </span>
                      <span class="shrink-0 text-muted-foreground/70">{data().key}</span>
                    </>
                  )}
                </Show>
                <span class="min-w-0 flex-1 truncate">
                  <Show when={data().previous !== undefined}>
                    <span class="text-muted-foreground/60">{shown(data().previous)} → </span>
                  </Show>
                  <span class="text-foreground/85">{shown(data().value)}</span>
                </span>
              </li>
            )
          }}
        </For>
      </ul>
      <p class="px-3 py-4 text-center font-mono text-[11px] text-muted-foreground/70">
        {changes() === undefined
          ? 'loading…'
          : changes()?.length === 0
            ? 'no UI changes recorded yet'
            : 'changes among the newest 100 recorded events'}
      </p>
    </div>
  )
}

const tab = { id: 'ui', title: 'UI changes', component: Changes }

export default defineWebExtension({
  provides: [provide(SystemTab, () => () => tab)],
})
