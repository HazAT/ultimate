/** @jsxImportSource @solidjs/web */
import { createMemo, For, Show } from 'solid-js'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command.solid.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog.solid.tsx'
import { Kbd, KbdGroup } from '@/components/ui/kbd.solid.tsx'
import { formatKeys, runCommand, useCommands, useStore } from '../sdk/hooks.ts'
import { applies, currentContext } from '../sdk/actions.ts'
import { store } from '../sdk/client.ts'
import { HOME } from '../sdk/registry.ts'

export function Shortcut(props: { keys: string }) {
  return (
    <span class="flex items-center gap-1">
      <For each={formatKeys(props.keys)}>
        {(chord) => (
          <KbdGroup>
            <For each={chord}>{(key) => <Kbd>{key}</Kbd>}</For>
          </KbdGroup>
        )}
      </For>
    </span>
  )
}

export function CommandPalette() {
  const open = useStore((state) => state.ui.paletteOpen)
  const state = useStore((current) => current)
  const commands = useCommands()
  const groups = createMemo(() => {
    if (!open()) return []
    const surface = state().ui.surface?.id ?? HOME
    const context = currentContext()
    const noOpCommands = new Set(['ultimate.palette', `ultimate.surface.${surface}`])
    const visible = commands().filter(
      (command) => !noOpCommands.has(command.id) && applies(command, context),
    )
    return [...Map.groupBy(visible, (command) => command.group ?? command.extension)]
  })
  const run = (id: string) => {
    store.setUi({ paletteOpen: false })
    runCommand(id)
  }
  return (
    <Dialog onOpenChange={(next) => store.setUi({ paletteOpen: next })} open={open()}>
      <DialogContent
        backdropClass="data-ending-style:transition-none"
        class="top-[18%] translate-y-0 gap-0 overflow-hidden p-0 font-mono data-ending-style:transition-none sm:max-w-xl"
        showCloseButton={false}
      >
        <DialogTitle class="sr-only">Command Palette</DialogTitle>
        <DialogDescription class="sr-only">Search for a command to run...</DialogDescription>
        <Command onAction={run}>
          <CommandInput
            aria-label="Search commands"
            class="text-[13px]"
            placeholder="Run a command…"
          />
          <CommandList class="max-h-[50vh]" data-ui="palette">
            <CommandEmpty class="py-6 text-center text-[12px] text-muted-foreground">
              No matching command.
            </CommandEmpty>
            <For each={groups()} keyed={([group]) => group}>
              {(group) => (
                <CommandGroup heading={group()[0]}>
                  <For each={group()[1]} keyed={(command) => command.id}>
                    {(command) => (
                      <CommandItem
                        class="text-[12.5px]"
                        keywords={[command().id, command().extension]}
                        label={command().title}
                        value={command().id}
                      >
                        <span class="truncate">{command().title}</span>
                        <Show when={command().keys}>
                          {(keys) => (
                            <CommandShortcut>
                              <Shortcut keys={keys()} />
                            </CommandShortcut>
                          )}
                        </Show>
                      </CommandItem>
                    )}
                  </For>
                </CommandGroup>
              )}
            </For>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
