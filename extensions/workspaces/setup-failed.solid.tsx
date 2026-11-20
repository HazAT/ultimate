/** @jsxImportSource @solidjs/web */
import { CircleAlert } from '@lucide/solid'
import { renderEntry } from '@/sdk/parts.solid.tsx'
import { OutputTail } from './log-parts.solid.tsx'
import { SetupFailedEntry } from './refs.ts'

export const SetupFailed = renderEntry(SetupFailedEntry, (props) => (
  <section class="min-w-0 rounded-md border border-border border-l-2 border-l-destructive/60 bg-muted/20">
    <header class="flex items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
      <CircleAlert class="size-3.5 text-destructive" />
      <span>workspace setup failed</span>
    </header>
    <div class="space-y-1.5 px-3 py-2.5 text-[13px] leading-relaxed">
      <p class="text-destructive">{props.entry.data.error.split('\n')[0]}</p>
      <p class="text-[12px] text-muted-foreground">
        Tools stay blocked without rerunning it; <code>workspace status</code> retries once the
        cause is fixed.
      </p>
      <OutputTail context={`setup failure #${props.entry.id}`} output={props.entry.data.error} />
    </div>
  </section>
))
