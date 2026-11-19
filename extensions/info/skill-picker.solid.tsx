/** @jsxImportSource @solidjs/web */
import { createEffect, For } from 'solid-js'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command.solid.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog.solid.tsx'
import { fillComposer, uncoveredComposer, useDialog, useSystem } from '@/sdk/solid'

export const skillDialog = 'info.skill'

export function SkillPicker() {
  const [open, setOpen] = useDialog(skillDialog)
  const system = useSystem()
  let composer: HTMLElement | undefined
  let filled: HTMLElement | undefined
  createEffect(open, (isOpen) => {
    if (!isOpen) return
    composer = uncoveredComposer()
    filled = undefined
  })
  function choose(name: string) {
    const id = Number(composer?.dataset.conversation)
    filled = Number.isInteger(id) ? composer : undefined
    if (filled) fillComposer(id, `/skill:${name} `)
    setOpen(false)
  }
  return (
    <Dialog onOpenChange={setOpen} open={open()}>
      <DialogContent
        finalFocus={() => filled}
        class="top-[18%] translate-y-0 gap-0 overflow-hidden p-0 font-mono sm:max-w-xl"
        showCloseButton={false}
      >
        <DialogTitle class="sr-only">Run a skill</DialogTitle>
        <DialogDescription class="sr-only">
          Pick a skill; the composer then holds its command for you to add a request and send.
        </DialogDescription>
        <Command filter="contains" onAction={choose}>
          <CommandInput aria-label="Find a skill" class="text-[13px]" placeholder="Run a skill…" />
          <CommandEmpty class="py-6 text-center text-[12px] text-muted-foreground">
            No matching skill.
          </CommandEmpty>
          <CommandList class="max-h-[50vh]">
            <For each={system()?.skills ?? []}>
              {(skill) => (
                <CommandItem
                  class="flex-col items-start gap-0.5 py-1.5"
                  keywords={[skill.description]}
                  label={skill.name}
                  value={skill.name}
                >
                  <span class="flex w-full items-center gap-2 text-[12.5px]">
                    <span class="text-brand">{skill.name}</span>
                    <span class="ml-auto text-[11px] text-muted-foreground/60">
                      {skill.scope}
                      {skill.manual && ' · manual'}
                    </span>
                  </span>
                  <span class="line-clamp-2 font-sans text-[11.5px] leading-snug text-muted-foreground">
                    {skill.description}
                  </span>
                </CommandItem>
              )}
            </For>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
