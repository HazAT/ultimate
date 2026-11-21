/** @jsxImportSource @solidjs/web */
import { ChevronRightIcon, LoaderCircleIcon, MoonIcon, MoonStarIcon } from '@lucide/solid'
import { For, Show, createMemo, createSignal } from 'solid-js'
import { Markdown } from '@/components/markdown/markdown.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import { Input } from '@/components/ui/input.solid.tsx'
import {
  ROOT,
  Card,
  formatTime,
  useDialog,
  useDocOf,
  useNow,
  useSystem,
  type EntryRecord,
} from '@/sdk/solid'
import {
  BusyBlocker,
  CHAPTER_NAME,
  chapterLabel,
  chaptersDialog,
  fallAsleep,
  useBusyElsewhere,
  useChapters,
} from './chapters.solid.tsx'
import { Moon } from './moon.solid.tsx'
import { DreamDoc } from './refs.ts'
import { ChapterPrepared } from './entries.ts'
import type { Prepared, Sleep } from './refs.ts'

type Step = Exclude<Sleep['phase'], 'asleep' | 'failed'>
const STEPS: Step[] = ['seeding', 'backing up', 'switching']

const titles: Record<Step, string> = {
  seeding: 'Pack what carries over',
  'backing up': 'Back up this chapter',
  switching: 'Switch',
}

const elapsed = (now: number, at: number) => {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function PreparedCard(props: { entry: EntryRecord }) {
  const doc = useDocOf(() => ROOT, DreamDoc)
  const at = () => (ChapterPrepared.is(props.entry) ? props.entry.data.at : undefined)
  return (
    <Show when={doc() !== undefined && at() !== undefined}>
      <Show
        when={doc()?.prepared?.at === at() && doc()?.prepared}
        fallback={
          <Card data-dream-prepared="replaced">
            <p class="flex items-center gap-2 px-3 py-2 font-mono text-[11px] text-muted-foreground">
              <MoonIcon class="size-3.5" />
              Next chapter prepared {formatTime(at()!)} · replaced by a later one
            </p>
          </Card>
        }
      >
        {(prepared) => (
          <NextChapter
            name={`prepared card #${props.entry.id}`}
            prepared={prepared()}
            sleep={doc()?.sleep}
          />
        )}
      </Show>
    </Show>
  )
}

export function NextChapter(props: {
  name: string
  prepared: Prepared
  sleep?: Sleep
  class?: string
}) {
  const progress = () => props.sleep?.phase !== 'failed' && props.sleep
  return (
    <Card
      attention={!props.sleep || props.sleep.phase === 'failed'}
      class={props.class}
      data-dream-prepared={props.prepared.chapter}
    >
      <header class="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <MoonStarIcon class="size-3.5 text-brand" />
        <span class="text-foreground">Next chapter prepared</span>
        <span>{formatTime(props.prepared.at)}</span>
      </header>
      <ul class="space-y-1.5 px-4 pt-4 pb-3" data-dream-learned>
        <For each={props.prepared.learned}>
          {(line) => (
            <li class="border-l-2 border-brand/30 pl-3 text-[14.5px] leading-snug text-foreground/90">
              {line}
            </li>
          )}
        </For>
      </ul>
      <Collapsible class="group/handoff px-4 pb-3" data-dream-handoff>
        <CollapsibleTrigger
          aria-label={`Read my handover in the ${props.name}`}
          class="flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
        >
          <ChevronRightIcon class="size-3 transition-transform group-data-open/handoff:rotate-90 motion-reduce:transition-none" />
          Read my handover
        </CollapsibleTrigger>
        <CollapsibleContent class="pt-2 text-[13px] leading-relaxed">
          <Markdown text={props.prepared.handoff} />
        </CollapsibleContent>
      </Collapsible>
      <Show
        when={progress()}
        fallback={<Ready failed={props.sleep} name={props.name} prepared={props.prepared} />}
      >
        {(sleep) => <Progress sleep={sleep()} />}
      </Show>
    </Card>
  )
}

function Ready(props: { name: string; prepared: Prepared; failed?: Sleep }) {
  const chapters = useChapters()
  const busy = useBusyElsewhere()
  const system = useSystem()
  const [draft, setName] = createSignal<string>()
  const name = () => draft() ?? props.failed?.chapter ?? props.prepared.chapter
  const [starting, setStarting] = createSignal(false)
  const [refusal, setRefusal] = createSignal<string>()
  const number = () => (chapters()?.chapters.length ?? 0) + 1
  const taken = () => chapters()?.chapters.some((item) => item.name === name())
  const invalid = () => !CHAPTER_NAME.test(name())
  const blocked = () => busy().length > 0
  const start = async () => {
    setStarting(true)
    setRefusal(undefined)
    setRefusal(await fallAsleep(chapterLabel(number(), name()), name(), system()?.process.pid))
    setStarting(false)
  }
  return (
    <section class="border-t border-border/60 px-4 pt-3 pb-3.5" data-dream-sleep="ready">
      <Show when={props.failed}>{(sleep) => <Failed sleep={sleep()} />}</Show>
      <div class="flex items-start gap-3">
        <MoonIcon class="mt-0.5 size-4 shrink-0 text-brand" />
        <div class="min-w-0 flex-1 space-y-2.5">
          <div class="space-y-0.5">
            <p class="text-[13px] text-foreground">
              {props.failed ? 'Try falling asleep again' : 'Fall asleep'}
            </p>
            <p class="text-[12px] leading-relaxed text-muted-foreground">
              I carry my memory, open work and this handover into a fresh chapter and wake up there.
              This one stays on disk; you can come back any time.
            </p>
          </div>
          <label class="flex max-w-full items-center rounded-md border border-border bg-background font-mono text-[12.5px] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30 sm:w-fit">
            <span class="shrink-0 border-r border-border/70 px-2 py-1 text-muted-foreground">
              Chapter {number()} ·
            </span>
            <Input
              aria-invalid={invalid() || taken() ? 'true' : undefined}
              aria-label={`Name of the new chapter in the ${props.name}`}
              class="h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent px-2 py-1 text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:ring-0 sm:w-56 sm:flex-none"
              data-dream-chapter-name
              disabled={starting()}
              maxlength={40}
              onValueChange={(value, details) => {
                const normalized = value.toLowerCase().replaceAll(' ', '-')
                const field = details.event?.target
                if (normalized !== value && field instanceof HTMLInputElement)
                  field.value = normalized
                setName(normalized)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !invalid() && !taken() && !blocked() && !starting())
                  void start()
              }}
              placeholder="two-or-three-words"
              value={name()}
            />
          </label>
          {(taken() || (invalid() && name())) && (
            <p class="text-[11.5px] text-warning">
              {taken()
                ? `There already is a chapter ${name()}; pick another name, or switch to it from Chapters.`
                : 'Lowercase letters, digits and dashes, up to 40.'}
            </p>
          )}
          {blocked() && (
            <div class="space-y-1.5">
              <BusyBlocker busy={busy()} />
              <p class="text-[12px] leading-relaxed text-muted-foreground">
                This wait clears automatically when they finish. Then press Fall asleep to switch
                chapters.
              </p>
            </div>
          )}
          {refusal() && (
            <p class="text-[12px] leading-relaxed" role="alert">
              <span class="text-error">Didn't start.</span>{' '}
              <span class="text-muted-foreground">{refusal()}</span>
            </p>
          )}
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Button
              aria-label={`Fall asleep from the ${props.name}`}
              class="border-brand/50 hover:border-brand"
              data-dream-asleep
              disabled={blocked() || invalid() || !!taken() || starting() || !chapters()}
              onClick={start}
              size="sm"
              variant="outline"
            >
              {starting() ? (
                <LoaderCircleIcon class="text-brand motion-safe:animate-spin" />
              ) : (
                <MoonIcon class="text-brand" />
              )}
              Fall asleep
            </Button>
            <span class="font-mono text-[11px] text-muted-foreground">
              under a minute · no model · restarts the server
            </span>
          </div>
        </div>
      </div>
    </section>
  )
}

function Failed(props: { sleep: Sleep }) {
  const chapters = useChapters()
  const backup = () => props.sleep.backup
  return (
    <div
      class="mb-3 rounded-md border border-error/30 bg-error/5 px-3 py-2.5"
      data-dream-sleep="failed"
      role="alert"
    >
      <p class="flex items-center gap-2 text-[12.5px] text-foreground">
        <Moon status="failed" />
        Falling asleep failed
        <span class="ml-auto font-mono text-[11px] text-muted-foreground">
          {formatTime(props.sleep.at)}
        </span>
      </p>
      {(backup()?.id || backup()?.skipped) && (
        <p class="mt-1 font-mono text-[11px] text-muted-foreground">
          {backup()?.id && `backed up ${backup()?.id?.slice(0, 12)}`}
          {backup()?.skipped && `backup skipped: ${backup()?.skipped}`}
        </p>
      )}
      {props.sleep.error && (
        <p class="mt-1.5 font-mono text-[11px] leading-relaxed break-words text-error/90">
          {props.sleep.error.replace(/^Error: /, '')}
        </p>
      )}
      <p class="mt-2 text-[12px] text-muted-foreground">
        Nothing moved: we're still in{' '}
        <span class="text-foreground">
          <Show when={chapters()} fallback="this chapter">
            {(chapter) => chapterLabel(chapter().number, chapter().active)}
          </Show>
        </span>
        .
      </p>
    </div>
  )
}

function Progress(props: { sleep: Sleep }) {
  const chapters = useChapters()
  const [, setChapters] = useDialog(chaptersDialog)
  const running = createMemo(() => props.sleep.phase !== 'asleep')
  const now = useNow(1000, running)
  const current = () => STEPS.indexOf(props.sleep.phase as Step)
  const label = () => {
    const { chapter } = props.sleep
    const list = chapters()?.chapters ?? []
    const number = running() ? list.length + 1 : list.find((item) => item.name === chapter)?.number
    return number ? chapterLabel(number, chapter) : chapter
  }
  return (
    <Show
      when={running()}
      fallback={
        <section
          class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-4 py-2.5 text-[12px]"
          data-dream-sleep="asleep"
        >
          <MoonIcon class="size-3.5 text-brand" />
          <span class="text-muted-foreground">
            Fell asleep into <span class="text-foreground">{label()}</span> ·{' '}
            {formatTime(props.sleep.at)}
          </span>
          {chapters() && chapters()?.active !== props.sleep.chapter && (
            <Button
              size={null}
              variant={null}
              class="ml-auto font-mono text-[11px] font-normal text-foreground/85 hover:text-foreground"
              onClick={() => setChapters(true)}
              type="button"
            >
              Chapters…
            </Button>
          )}
        </section>
      }
    >
      <section
        aria-live="polite"
        class="border-t border-border/60 px-4 pt-3 pb-3.5"
        data-dream-sleep={props.sleep.phase}
      >
        <p class="flex flex-wrap items-baseline gap-x-2 text-[13px] text-foreground">
          Falling asleep
          <span class="font-mono text-[11.5px] text-muted-foreground">into {label()}</span>
        </p>
        <ol class="mt-2 space-y-1.5">
          <For each={STEPS}>
            {(step, index) => {
              const status = () =>
                index() < current() ? 'done' : index() === current() ? 'running' : 'waiting'
              return (
                <li data-status={status()} data-step={step}>
                  <div class="grid grid-cols-[0.75rem_minmax(0,1fr)_auto] items-baseline gap-x-2 text-[12px] leading-5">
                    <Moon class="translate-y-0.5 self-start" status={status()} />
                    <span
                      class={status() === 'waiting' ? 'text-muted-foreground' : 'text-foreground'}
                    >
                      {titles[step]}
                      <span class="text-muted-foreground"> {detail(step, props.sleep)}</span>
                    </span>
                    {status() === 'running' && (
                      <span class="font-mono text-[11px] text-muted-foreground tabular-nums">
                        {elapsed(now(), props.sleep.at)}
                      </span>
                    )}
                  </div>
                </li>
              )
            }}
          </For>
        </ol>
        <p class="mt-2.5 text-[11.5px] text-muted-foreground">
          Start no other work until I'm asleep — anything that starts now cancels the switch.
        </p>
      </section>
    </Show>
  )
}

function detail(step: Step, sleep: Sleep) {
  if (step === 'seeding') return '— memories, open to-dos, questions, automations, my handover'
  if (step === 'backing up') {
    if (sleep.backup?.id) return `— backup ${sleep.backup.id.slice(0, 12)}`
    if (sleep.backup?.skipped) return `— skipped: ${sleep.backup.skipped}`
    return '— the last cloud backup of this chapter'
  }
  return '— the server restarts into the new chapter'
}
