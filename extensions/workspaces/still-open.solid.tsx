import { CircleDot } from '@lucide/solid'
import { Card, renderEntry } from '@/sdk/solid'
import { ConversationRef } from '../conversations/ui.solid.tsx'
import { Open } from './landing.solid.tsx'
import { StillOpenEntry } from './refs.ts'

export const StillOpen = renderEntry(StillOpenEntry, (props) => (
  <Card attention data-landed-still-open={props.entry.data.id}>
    <header class="flex min-w-0 items-center gap-2 px-3 py-2 font-mono text-[11px] text-muted-foreground">
      <CircleDot class="size-3.5 shrink-0 text-warning" />
      <span class="shrink-0">landed, still open</span>
      <span class="min-w-0 truncate text-foreground">
        <ConversationRef id={props.entry.data.id} />
      </span>
      <span class="hidden shrink-0 sm:inline">· work still under way</span>
      <div class="ml-auto flex shrink-0">
        <Open card={props.entry.id} id={props.entry.data.id} />
      </div>
    </header>
  </Card>
))
