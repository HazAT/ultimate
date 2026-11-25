import type { EntryRecord } from '@earendil-works/pi-durable'
import { ChevronRight } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { createMemo, Show } from 'solid-js'
import { MentionText } from '@/components/markdown/markdown.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import { useTranscript } from '@/sdk/solid'
import { compareUrl } from '../../lib/compare.ts'
import { NoteEntry } from '../entries/refs.ts'
import type { NoteData } from '../entries/refs.ts'
import { LandingCard } from './landing.solid.tsx'
import { CommitCount, useGithubRepo } from './ui.solid.tsx'

type Landing = Extract<NoteData, { source: 'lander' }>
const landing = (entry: EntryRecord) =>
  NoteEntry.is(entry) && entry.data.source === 'lander' ? entry.data : undefined

export function LandingNote(props: { entry: EntryRecord; core: JSX.Element }) {
  return (
    <Show when={landing(props.entry)} fallback={props.core}>
      {(data) => <NoteCard id={props.entry.id} data={data()} />}
    </Show>
  )
}

function NoteCard(props: { id: number; data: Landing }) {
  const github = useGithubRepo()
  const transcript = useTranscript()
  const base = createMemo(() => {
    if (props.data.base !== undefined) return props.data.base
    const id = props.id
    const previous = transcript().findLast((entry) => entry.id < id && landing(entry))
    return previous && landing(previous)?.sha
  })
  const href = () => {
    const repo = github()
    const from = base()
    return repo && from ? compareUrl(repo, from, props.data.sha) : undefined
  }
  return (
    <div data-lineage-note="lander">
      <LandingCard
        card={props.id}
        divergence={props.data.divergence}
        from={props.data.from}
        headline={
          <span class="flex flex-wrap items-center gap-x-2">
            <span>
              Landed {props.data.sha.slice(0, 7)} on {props.data.target}
              {props.data.pushed ? ` · pushed to ${props.data.pushed}` : ''}
            </span>
            <CommitCount
              card={props.id}
              class="text-muted-foreground"
              count={props.data.commits.length + props.data.more}
              href={href()}
              range={base() ? `${base()}...${props.data.sha}` : undefined}
            />
          </span>
        }
        pushed={!!props.data.pushed}
        sha={props.data.sha}
        sourceEntry={props.data.at}
        subject={{
          title: props.data.title,
          summary: props.data.summary,
          feature: props.data.feature,
        }}
        submission={props.data.submission}
        target={props.data.target}
        tone="landed"
      >
        <Show when={props.data.paths.length}>
          <p class="break-words text-muted-foreground">Changed: {props.data.paths.join(', ')}</p>
        </Show>
        <Show when={props.data.abstract}>
          {(abstract) => (
            <Collapsible class="group/state">
              <CollapsibleTrigger
                aria-label={`State at landing #${props.id}`}
                class="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              >
                <ChevronRight class="size-3 transition-transform group-data-open/state:rotate-90" />
                State at landing
                <span class="text-muted-foreground/70">
                  · #{props.data.from}/{abstract().at}
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent class="pt-1 pl-4 font-sans text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
                <MentionText text={abstract().text} />
              </CollapsibleContent>
            </Collapsible>
          )}
        </Show>
      </LandingCard>
    </div>
  )
}
