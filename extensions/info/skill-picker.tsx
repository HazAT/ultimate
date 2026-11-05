import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { fillComposer, useDialog, useSystem, useUltimate } from '@/sdk'

export const skillDialog = 'info.skill'

/**
 * ⌘K → Run a skill: picking one writes `/skill:name ` into the shown conversation's composer, where the user adds the
 * request and sends it; the server sends the skill's instructions with it.
 */
export function SkillPicker() {
  const [open, setOpen] = useDialog(skillDialog)
  const actions = useUltimate()
  const skills = useSystem()?.skills ?? []
  function choose(name: string) {
    setOpen(false)
    if (actions.conversationId === undefined) return
    fillComposer(actions.conversationId, `/skill:${name} `)
    actions.focusComposer()
  }
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent
        className="top-[18%] translate-y-0 gap-0 overflow-hidden p-0 font-mono sm:max-w-xl"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Run a skill</DialogTitle>
        <DialogDescription className="sr-only">
          Pick a skill; the composer then holds its command for you to add a request and send.
        </DialogDescription>
        <Command>
          <CommandInput className="text-[0.8125rem]" placeholder="Run a skill…" />
          <CommandList className="max-h-[50vh]">
            <CommandEmpty className="py-6 text-center text-[0.75rem] text-muted-foreground">
              No matching skill.
            </CommandEmpty>
            {skills.map((skill) => (
              <CommandItem
                className="flex-col items-start gap-0.5 py-1.5"
                key={skill.path}
                keywords={[skill.description]}
                onSelect={() => choose(skill.name)}
                value={skill.name}
              >
                <span className="flex w-full items-center gap-2 text-[0.7812rem]">
                  <span className="text-brand">{skill.name}</span>
                  <span className="ml-auto text-[0.6875rem] text-muted-foreground">
                    {skill.scope}
                    {skill.manual && ' · manual'}
                  </span>
                </span>
                <span className="line-clamp-2 font-sans text-[0.7188rem] leading-snug text-muted-foreground">
                  {skill.description}
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
