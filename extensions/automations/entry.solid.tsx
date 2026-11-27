import type { TypedEntry } from '@earendil-works/pi-durable'
import { Timer } from '@lucide/solid'
import { Show } from 'solid-js'
import { Markdown } from '@/components/markdown/markdown.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import { Fold, renderEntry, api, cn, openPanel, showSurface, switchConversation } from '@/sdk/solid'
import { FiredEntry, FinishedEntry } from '../entries/refs.ts'
import { FailedEntry, EscalatedEntry, WritingEntry } from './entries.shared.ts'
import { looks } from './looks.web.ts'
import type { Look } from './looks.web.ts'
import { openAutomation } from './navigation.web.ts'
import { Dot } from './parts.solid.tsx'
import type { AutomationInput } from './refs.ts'

const shell = { openPanel, showSurface, switchConversation }

const kinds = {
  fired: { look: 'watching', word: 'fired', border: 'border-l-success/70' },
  finished: { look: 'watching', word: 'finished', border: 'border-l-success/70' },
  failed: { look: 'investigating', word: 'failed', border: 'border-l-warning/70' },
  escalated: { look: 'failed', word: 'escalated', border: 'border-l-error/70' },
  writing: { look: 'writing', word: 'assigned', border: 'border-l-brand/60' },
} satisfies Record<string, { look: Look; word: string; border: string }>

type Kind = keyof typeof kinds

function body(text: string) {
  const trimmed = text.trim()
  if (/^[[{]/.test(trimmed))
    try {
      return `\`\`\`json\n${JSON.stringify(JSON.parse(trimmed), null, 2)}\n\`\`\``
    } catch {
      return text
    }
  return text
}

const shown = (kind: Kind, data: AutomationInput): Kind =>
  kind === 'finished' && data.text.startsWith('Run failed:') ? 'failed' : kind

function EntryLabel(props: { data: AutomationInput; kind: Kind }) {
  const look = () => kinds[shown(props.kind, props.data)]
  return (
    <>
      <span class="shrink-0 text-muted-foreground">{props.data.id}</span>
      <span class="min-w-0 truncate text-foreground" title={props.data.name}>
        {props.data.name}
      </span>
      <span class={cn('shrink-0', looks[look().look].text)}>{look().word}</span>
    </>
  )
}

const card = (kind: Kind) =>
  function AutomationEntry(props: { entry: TypedEntry<AutomationInput> }) {
    const data = () => props.entry.data
    const look = () => kinds[shown(kind, data())]
    return (
      <Fold
        card={props.entry.id}
        label={`Toggle automation ${data().id} ${look().word} report #${props.entry.id}`}
        summary={
          <>
            <Dot look={look().look} />
            <span class="flex min-w-0 items-center gap-1.5 text-foreground/80">
              <EntryLabel data={data()} kind={kind} />
            </span>
          </>
        }
      >
        <section
          class={cn(
            'min-w-0 rounded-md border border-l-2 border-border bg-muted/20',
            look().border,
          )}
          data-automation-entry={kind}
        >
          <header class="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px]">
            <Timer class="size-3.5 shrink-0 text-muted-foreground" />
            <span class="flex min-w-0 items-center gap-1.5">
              <EntryLabel data={data()} kind={kind} />
            </span>
            <Button
              aria-label={`Open ${data().id} in Automations from report #${props.entry.id}`}
              class="ml-auto shrink-0 text-[11px] font-normal text-muted-foreground hover:text-foreground hover:underline"
              onClick={() => openAutomation(data().id, shell, api.action)}
              size={null}
              title={`Show ${data().id} in Automations`}
              variant={null}
            >
              open {data().id}
            </Button>
          </header>
          <Show when={data().text}>
            {(text) => (
              <div
                class={cn(
                  'min-w-0 px-3 py-2.5 text-[13px] leading-relaxed',
                  kind === 'writing' && 'text-foreground/85',
                )}
              >
                <Markdown text={kind === 'writing' ? text() : body(text())} />
              </div>
            )}
          </Show>
        </section>
      </Fold>
    )
  }

export const Fired = renderEntry(FiredEntry, card('fired'))
export const Finished = renderEntry(FinishedEntry, card('finished'))
export const Failed = renderEntry(FailedEntry, card('failed'))
export const Escalated = renderEntry(EscalatedEntry, card('escalated'))
export const Writing = renderEntry(WritingEntry, card('writing'))
