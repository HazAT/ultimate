import { renderEntry } from '@/sdk/solid'
import { IdleEntry } from './entries.shared.ts'

export const Idle = renderEntry(IdleEntry, (props) => (
  <p class="whitespace-pre-line font-mono text-[11px] text-muted-foreground">
    {props.entry.data.text}
  </p>
))
