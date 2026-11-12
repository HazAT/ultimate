import { Fragment } from 'react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { actions, applies, currentContext } from '../sdk/actions.ts'
import { store } from '../sdk/client.ts'
import { useCommands, useStore } from '../sdk/hooks.ts'
import { formatKeys } from '../sdk/keys.ts'

export function Shortcut({ keys }: { keys: string }) {
  return (
    <span className="flex items-center gap-1">
      {formatKeys(keys).map((chord, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- Chord positions in a fixed shortcut sequence.
        <KbdGroup key={index}>
          {chord.map((key) => (
            <Kbd key={key}>{key}</Kbd>
          ))}
        </KbdGroup>
      ))}
    </span>
  )
}

/** Every command, core and extension, searchable; `mod+k`. */
export function CommandPalette() {
  // A command can adjust the UI without closing the palette; re-evaluate its visibility in the new state.
  const { paletteOpen: open } = useStore((state) => state.ui)
  const commands = useCommands()
  const context = currentContext()
  // The palette itself and a switch to the shown surface would do nothing here.
  const hidden = new Set(['ultimate.palette', `ultimate.surface.${context.surface}`])
  const visible = open
    ? commands.filter((command) => !hidden.has(command.id) && applies(command, context))
    : []
  const groups = Map.groupBy(visible, (command) => command.group ?? command.extension)
  return (
    <CommandDialog
      className="top-[18%] translate-y-0 font-mono sm:max-w-xl"
      onOpenChange={(next) => store.setUi({ paletteOpen: next })}
      open={open}
      showCloseButton={false}
    >
      <CommandInput className="text-[13px]" placeholder="Run a command…" />
      <CommandList className="max-h-[50vh]" data-ui="palette">
        <CommandEmpty className="py-6 text-center text-[12px] text-muted-foreground">
          No matching command.
        </CommandEmpty>
        {[...groups].map(([group, items]) => (
          <Fragment key={group}>
            <CommandGroup heading={group}>
              {items.map((command) => {
                const title = typeof command.title === 'function' ? command.title() : command.title
                return (
                  <CommandItem
                    className="text-[12.5px]"
                    key={command.id}
                    keywords={[title, command.extension]}
                    onSelect={() => {
                      if (!command.keepOpen) store.setUi({ paletteOpen: false })
                      actions.runCommand(command.id)
                    }}
                    value={command.id}
                  >
                    <span className="truncate">{title}</span>
                    {command.keys && (
                      <CommandShortcut>
                        <Shortcut keys={command.keys} />
                      </CommandShortcut>
                    )}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </Fragment>
        ))}
      </CommandList>
    </CommandDialog>
  )
}
