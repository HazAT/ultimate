import { CheckIcon } from 'lucide-react'
import { Command, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  cn,
  defineWebExtension,
  getState,
  resolvedTheme,
  useDarkTheme,
  useDialog,
  useStore,
  useUltimate,
} from '@/sdk'
import type { ThemePreference } from '@/sdk'

const appearanceDialog = 'theme.appearance'

const choices: { value: ThemePreference; hint: string }[] = [
  { value: 'system', hint: 'Follow the device' },
  { value: 'light', hint: 'Always light' },
  { value: 'dark', hint: 'Always dark' },
]

/** System, Light and Dark, with the choice this browser made; the shell applies it (web/src/sdk/theme.ts). */
function Appearance() {
  const [open, setOpen] = useDialog(appearanceDialog)
  const preference = useStore((state) => state.ui.theme)
  const dark = useDarkTheme()
  const { setTheme } = useUltimate()
  const now = dark ? 'dark' : 'light'
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent
        className="top-[18%] translate-y-0 gap-0 overflow-hidden p-0 font-mono sm:max-w-xs"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Appearance</DialogTitle>
        <DialogDescription className="sr-only">
          The light or dark theme of this browser.
        </DialogDescription>
        <div className="flex items-baseline gap-2 border-b border-border/70 px-3 py-2 text-[12px]">
          <span className="text-muted-foreground">Appearance</span>
          <span className="min-w-0 truncate text-foreground capitalize" data-testid="theme-current">
            {preference}
          </span>
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">now {now}</span>
        </div>
        <Command shouldFilter={false}>
          <CommandList>
            {choices.map((choice) => (
              <CommandItem
                className="gap-2 py-1 font-mono text-[12px]"
                key={choice.value}
                onSelect={() => {
                  setTheme(choice.value)
                  setOpen(false)
                }}
                value={choice.value}
              >
                <CheckIcon
                  className={cn(
                    'size-3.5',
                    preference === choice.value ? 'text-brand' : 'opacity-0',
                  )}
                />
                <span className="capitalize">{choice.value}</span>
                <span className="ml-auto truncate text-[11px] text-muted-foreground">
                  {choice.hint}
                </span>
              </CommandItem>
            ))}
          </CommandList>
          <div className="border-t border-border/70 px-3 py-1.5 text-[11px] text-muted-foreground">
            {preference === 'system' ? 'Following the device' : 'This browser only'}
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

export default defineWebExtension({
  slots: { overlay: [Appearance] },
  commands: [
    {
      id: 'theme.appearance',
      title: 'Appearance…',
      group: 'Ultimate',
      run: (context) => context.open(appearanceDialog),
    },
    {
      id: 'theme.toggle',
      title: 'Toggle light and dark theme',
      group: 'Ultimate',
      // The opposite of what is on screen, pinned: a browser following the system stops following it.
      run: (context) =>
        context.setTheme(resolvedTheme(getState().ui.theme) === 'dark' ? 'light' : 'dark'),
    },
  ],
})
