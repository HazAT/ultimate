import { CornerDownLeftIcon } from '@lucide/solid'
import { createSignal, For, Show } from 'solid-js'
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
import {
  formatAgo,
  keepLast,
  ROOT,
  useAction,
  useConversationId,
  useDialog,
  useNow,
} from '@/sdk/solid'
import { folderOf, markdownTarget } from './blocks.ts'
import type { Target } from './blocks.ts'
import { openReader } from './link.solid.tsx'
import { FilesAction } from './refs.ts'

export const pickerDialog = 'reader.pick'

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const OPEN_TYPED = 'reader.open-typed'

export function Picker() {
  const [open, setOpen] = useDialog(pickerDialog)
  return (
    <Dialog onOpenChange={setOpen} open={open()}>
      <DialogContent
        class="top-[18%] translate-y-0 gap-0 overflow-hidden p-0 font-mono sm:max-w-xl"
        showCloseButton={false}
      >
        <DialogTitle class="sr-only">Read a markdown file</DialogTitle>
        <DialogDescription class="sr-only">
          Pick a markdown file, or type its path, to read it beside the conversation.
        </DialogDescription>
        <Show when={open()}>
          <Files close={() => setOpen(false)} />
        </Show>
      </DialogContent>
    </Dialog>
  )
}

function Files(props: { close: () => void }) {
  const shown = useConversationId()
  const files = useAction(
    FilesAction,
    {
      get conversation() {
        return shown()
      },
    },
    { conversation: ROOT, onError: keepLast },
  )
  const now = useNow(60_000)
  const [query, setQuery] = createSignal('')
  const typed = () => markdownTarget(query())
  const listed = () => files.data()?.files.some((file) => file.path === typed()?.path)
  const choose = (target: Target) => {
    props.close()
    openReader(target)
  }
  return (
    <Command
      onAction={(value) => {
        const target = value === OPEN_TYPED ? typed() : { path: value }
        if (target) choose(target)
      }}
      onQueryChange={setQuery}
      query={query()}
    >
      <CommandInput
        aria-label="Search markdown files"
        class="text-[13px]"
        placeholder="Read a markdown file, or type a path…"
      />
      <CommandEmpty class="py-6 text-center text-[12px] text-muted-foreground">
        {files.loading() && !files.data()
          ? 'Listing files…'
          : files.error() && !files.data()
            ? 'Could not list files. Type a path.'
            : 'No matching file. Type a path ending in .md.'}
      </CommandEmpty>
      <CommandList class="max-h-[50vh]">
        <Show when={!listed() && typed()}>
          {(target) => (
            <CommandItem class="gap-2 py-1.5 text-[12.5px]" keywords={[query()]} value={OPEN_TYPED}>
              <CornerDownLeftIcon class="size-3.5 text-brand" />
              <span class="min-w-0 truncate">Open {target().path}</span>
              <Show when={target().line}>
                <span class="text-muted-foreground">:{target().line}</span>
              </Show>
            </CommandItem>
          )}
        </Show>
        <For each={files.data()?.files} keyed={(file) => file.path}>
          {(file) => (
            <CommandItem class="gap-2 py-1 text-[12.5px]" value={file().path}>
              <span class="shrink-0 text-foreground/90">{nameOf(file().path)}</span>
              <span class="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground/70">
                {folderOf(file().path)}
              </span>
              <span class="shrink-0 text-[11px] text-muted-foreground/60">
                {formatAgo(file().mtime, now())}
              </span>
            </CommandItem>
          )}
        </For>
      </CommandList>
    </Command>
  )
}
