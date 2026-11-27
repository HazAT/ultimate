import { Check } from '@lucide/solid'
import { For, Show, createMemo } from 'solid-js'
import { ROOT, formatTokens, plural, useDocOf, useTranscript } from '@/sdk/solid'
import type { CompactSummaryProps } from '@/sdk/solid'
import { cacheBusts } from '../../lib/context-usage.shared.ts'
import { backgroundRow, counterparts, emptyMessages, landed, landedSha } from './data.web.ts'
import { MessagesDoc } from './refs.ts'
import { Address } from './ui.solid.tsx'

export function StretchSummary(props: CompactSummaryProps) {
  const board = useDocOf(() => ROOT, MessagesDoc)
  const transcript = useTranscript()
  const busts = createMemo(() => cacheBusts(transcript()))
  const written = createMemo(() => {
    const byEntry = busts()
    const ids = new Set(props.entries.map((entry) => entry.id))
    return [...ids].reduce((sum, id) => sum + (byEntry.get(id)?.written ?? 0), 0)
  })
  const rows = createMemo(() => {
    const log = board() ?? emptyMessages
    return props.rows
      .map((row) => ({ row, background: backgroundRow(row, log) }))
      .filter(({ row, background }) => background !== 'hidden' && row.entry.kind !== 'pi.system')
  })
  const shas = createMemo(() => [
    ...new Set(rows().flatMap(({ row: { entry } }) => (landed(entry) ? [landedSha(entry)] : []))),
  ])
  const who = createMemo(() =>
    [
      ...new Set(
        rows().flatMap(({ row, background }) =>
          background === true ? counterparts(row, board() ?? emptyMessages) : [],
        ),
      ),
    ].filter((id) => id !== 'lander'),
  )
  const named = () => who().slice(0, who().length > 2 ? 1 : 2)
  const steps = () => props.steps > 0 && plural(props.steps, 'step')
  const reloaded = () => rows().some(({ row }) => row.entry.kind === 'prompt.build')
  return (
    <span class="flex min-w-0 items-center gap-1.5" data-compact-stretch>
      <span class="shrink-0">{rows().length ? plural(rows().length, 'update') : steps()}</span>
      <For each={named()}>
        {(id) => (
          <span class="flex min-w-0 overflow-hidden">
            <Address id={id} />
          </span>
        )}
      </For>
      <Show when={who().length > named().length}>
        <span class="shrink-0">+{who().length - named().length}</span>
      </Show>
      <Show when={rows().length && steps()}>
        <span class="shrink-0 max-sm:hidden">· {steps()}</span>
      </Show>
      <Show when={shas().length}>
        <span class="flex shrink-0 items-center gap-1" title={shas().join(' ')}>
          · <Check class="size-3 text-success" />
          {shas().length === 1 ? `landed ${shas()[0]}` : `${shas().length} landed`}
        </span>
      </Show>
      <Show when={reloaded()}>
        <span class="shrink-0 max-sm:hidden">· reloaded</span>
      </Show>
      <Show when={written() > 0}>
        <span class="shrink-0 text-warning/80" data-cache-rebuilt={written()}>
          · cache rebuilt · {formatTokens(written())} written
        </span>
      </Show>
      <Show when={props.working}>
        <span class="shrink-0 text-brand">· working</span>
      </Show>
    </span>
  )
}
