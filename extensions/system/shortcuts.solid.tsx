import { createSignal, For, onSettled } from 'solid-js'
import { Kbd, KbdGroup } from '@/components/ui/kbd.solid.tsx'
import { formatKeys, listShortcuts, onShortcutsChanged } from '@/sdk/solid'

export function Shortcuts() {
  const [list, setList] = createSignal(listShortcuts())
  onSettled(() => onShortcutsChanged(() => setList(listShortcuts())))
  return (
    <main class="min-h-0 flex-1 overflow-y-auto">
      <section class="mx-auto max-w-3xl px-3 py-3 md:px-5">
        <div class="rounded-lg border border-border/70 bg-card/40">
          <div class="border-b border-border/70 px-3 py-2 font-mono text-[11px] text-muted-foreground">
            <span class="section-label">Shortcuts</span>
            <span class="ml-2">every key the page has registered now</span>
          </div>
          <ul class="flex flex-col py-1">
            <For each={list()} keyed={(row) => `${row.keys} ${row.description}`}>
              {(row) => (
                <li class="flex items-center justify-between gap-3 px-3 py-1 font-mono text-[11.5px] text-foreground/85">
                  <span class="min-w-0 truncate">
                    {row().description ?? <span class="text-muted-foreground">no description</span>}
                  </span>
                  <KbdGroup>
                    <For each={formatKeys(row().keys)}>{(key) => <Kbd>{key}</Kbd>}</For>
                  </KbdGroup>
                </li>
              )}
            </For>
          </ul>
        </div>
      </section>
    </main>
  )
}
