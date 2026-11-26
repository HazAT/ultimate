import { MoonIcon } from '@lucide/solid'
import { Card, type EntryRecord } from '@/sdk/solid'
import type { RequestedEntry } from './refs.ts'

const awayFor = (ms: number) => `${Math.max(1, Math.round(ms / 3600_000))} h`

export function ReadyCard(props: { entry: EntryRecord }) {
  const branch = () => (props.entry.data as { branch?: number } | undefined)?.branch
  return (
    <Card data-dream-ready={branch()}>
      <p class="flex flex-wrap items-center gap-2 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <MoonIcon class="size-3.5 text-brand" />
        <span class="text-foreground">Fall asleep</span>
        <span>you pressed it after dream #{branch()} · preparing the next chapter</span>
      </p>
    </Card>
  )
}

function triggerText(automation: NonNullable<RequestedEntry['automation']>) {
  return `${automation.pause !== undefined ? `you were away ${awayFor(automation.pause)}` : 'my context filled up'} · automation ${automation.id}`
}

function requestText(data: RequestedEntry | undefined) {
  if (!data?.automation) return 'you pressed Dream'
  return `${data.agent ? 'I pressed Start · ' : ''}${triggerText(data.automation)}`
}

export function RequestedCard(props: { entry: EntryRecord }) {
  const data = () => props.entry.data as RequestedEntry | undefined
  return (
    <Card data-dream-requested={data()?.automation?.id ?? 'user'}>
      <p class="flex flex-wrap items-center gap-2 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <MoonIcon class="size-3.5 text-brand" />
        <span class="text-foreground">Time to dream</span>
        <span>{requestText(data())}</span>
      </p>
    </Card>
  )
}

export function AskedCard(props: { entry: EntryRecord }) {
  const automation = () => (props.entry.data as RequestedEntry | undefined)?.automation
  return (
    <Card data-dream-asked={automation()?.id}>
      <p class="flex flex-wrap items-center gap-2 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <MoonIcon class="size-3.5 text-brand/70" />
        <span class="text-foreground">Dream?</span>
        <span>{automation() ? `${triggerText(automation()!)} · ` : ''}asked you in the Inbox</span>
      </p>
    </Card>
  )
}
