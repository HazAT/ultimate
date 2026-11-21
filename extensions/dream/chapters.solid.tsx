/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import { ROOT } from '@/sdk/solid'
import {
  ArrowRightIcon,
  LibraryIcon,
  LoaderCircleIcon,
  MoonIcon,
  RotateCwIcon,
} from '@lucide/solid'
import { For, Show, createEffect, createMemo, createRoot, createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { StatusButton } from '@/components/ui/status-trigger.solid.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog.solid.tsx'
import {
  api,
  cn,
  errorMessage,
  keepLast,
  useAction,
  useConnection,
  useConversations,
  useDialog,
  useDocOf,
  useNow,
  useSystem,
  showSurface,
  switchConversation,
  writingAs,
} from '@/sdk/solid'
import { ConversationRef } from '../conversations/ui.solid.tsx'
import { AsleepAction, ChaptersAction, DreamDoc, SwitchAction } from './refs.ts'
import { busyElsewhere } from './types.ts'

export const chapterLabel = (number: number, name: string) => `Chapter ${number} · ${name}`

export const CHAPTER_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/

export const chaptersDialog = 'dream.chapters'

export function useChapters() {
  return useAction(ChaptersAction, null, { onError: keepLast }).data
}

export function useBusyElsewhere() {
  const conversations = useConversations()
  return createMemo(() => busyElsewhere(conversations()))
}

type ChapterRestartIntent = 'asleep' | 'switch'
type ActivationErrorAtDisconnect = { error?: string }
type RestartRolledBackToSameProcess = true

type Pending = {
  to: string
  verb: ChapterRestartIntent
  pid?: number
  since: number
  dropped?: ActivationErrorAtDisconnect
  failed?: RestartRolledBackToSameProcess
}

const [pending, setPending] = createRoot(() => createSignal<Pending>())

const OPEN_ULTIMATE_AFTER_WAKE_RELOAD = 'ultimate.dream.wake'

const cutOff = (error: unknown) => error instanceof Error && 'status' in error && error.status === 0

export async function switchChapter(label: string, name: string, pid?: number) {
  setPending({ to: label, verb: 'switch', pid, since: Date.now() })
  try {
    await api.action(SwitchAction, { chapter: name })
    setPending(undefined)
    return 'The switch did not happen'
  } catch (error) {
    if (cutOff(error)) return undefined
    setPending(undefined)
    return errorMessage(error)
  }
}

export async function fallAsleep(label: string, name: string, pid?: number) {
  try {
    await api.action(AsleepAction, { name })
    return undefined
  } catch (error) {
    if (!cutOff(error)) return errorMessage(error)
    setPending({ to: label, verb: 'asleep', pid, since: Date.now() })
    return undefined
  }
}

export function SwitchVeil() {
  const system = useSystem()
  const connection = useConnection()
  const doc = useDocOf(() => ROOT, DreamDoc)
  const chapters = useChapters()
  const processId = createMemo(() => system()?.process.pid)
  const now = useNow(1000, () => pending() !== undefined)
  createEffect(
    () => {
      const dream = doc()
      const sleep = dream?.sleep
      return {
        chapter: sleep?.phase === 'switching' ? sleep.chapter : undefined,
        count: chapters()?.chapters.length,
        pid: processId(),
        known: dream !== undefined,
        phase: sleep?.phase,
        at: sleep?.at,
        intent: pending(),
      }
    },
    ({ chapter, count, pid, known, phase, at, intent }, previous) => {
      if (
        chapter &&
        !intent &&
        count !== undefined &&
        (chapter !== previous?.chapter || count !== previous.count || pid !== previous.pid)
      ) {
        setPending({
          to: chapterLabel(count + 1, chapter),
          verb: 'asleep',
          pid,
          since: Date.now(),
        })
      }
      if (
        intent?.verb === 'asleep' &&
        intent.pid === pid &&
        known &&
        !chapter &&
        (known !== previous?.known ||
          phase !== previous?.phase ||
          at !== previous?.at ||
          pid !== previous?.pid)
      ) {
        setPending(undefined)
      }
    },
  )
  createEffect(
    () => ({
      pid: processId(),
      error: system()?.process.activationError,
      status: connection().status,
      intent: pending(),
    }),
    ({ pid, error, status, intent }, previous) => {
      if (pid === previous?.pid && error === previous?.error && status === previous?.status) return
      if (!intent || pid === undefined || intent.pid === undefined || intent.failed) return
      if (status !== 'open') {
        if (!intent.dropped) setPending({ ...intent, dropped: { error } })
        return
      }
      if (pid === intent.pid) {
        if (intent.dropped && error !== undefined && error !== intent.dropped.error)
          setPending({ ...intent, failed: true })
        return
      }
      if (intent.verb === 'asleep') sessionStorage.setItem(OPEN_ULTIMATE_AFTER_WAKE_RELOAD, '1')
      reloadChapterPage()
    },
  )
  useReloadOnChapterChange(processId)
  return (
    <Show when={pending()}>
      {(ours) =>
        ours().failed ? (
          <div
            class="fixed inset-0 z-[100] flex animate-fade-in items-center justify-center bg-background/95 backdrop-blur-sm"
            data-dream-veil="failed"
            role="alert"
          >
            <div class="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
              <MoonIcon class="size-6 text-muted-foreground" />
              <p class="text-[15px] text-foreground">The switch didn't happen</p>
              <p class="text-[12px] leading-relaxed text-muted-foreground">
                The new server failed to start and the old one took over again: nothing moved. The
                reason is in the supervisor's output.
              </p>
              <Button onClick={() => setPending(undefined)} size="xs" variant="outline">
                Stay here
              </Button>
            </div>
          </div>
        ) : (
          <output
            aria-live="polite"
            class="fixed inset-0 z-[100] flex animate-fade-in items-center justify-center bg-background/95 backdrop-blur-sm"
            data-dream-veil={ours().verb}
          >
            <div class="flex max-w-sm flex-col items-center gap-4 px-6 text-center">
              <MoonIcon
                class="size-6 text-brand motion-safe:animate-pulse-dot"
                style={{ 'animation-duration': '3.2s' }}
              />
              <div class="space-y-1.5">
                <p class="text-[15px] text-foreground">
                  {ours().verb === 'asleep' ? 'Falling asleep' : 'Switching chapters'}
                </p>
                <p class="font-mono text-[12px] text-muted-foreground">
                  {ours().verb === 'asleep' ? 'waking up in ' : 'to '}
                  <span class="text-foreground/90">{ours().to}</span>
                </p>
              </div>
              <p class="text-[12px] leading-relaxed text-muted-foreground">
                The server restarts into that chapter. This page reconnects by itself.
              </p>
              {now() - ours().since > 90_000 && (
                <div class="flex flex-col items-center gap-2 pt-1">
                  <p class="text-[12px] text-warning">This is taking longer than it should.</p>
                  <Button onClick={() => location.reload()} size="xs" variant="outline">
                    <RotateCwIcon />
                    Reload the page
                  </Button>
                </div>
              )}
            </div>
          </output>
        )
      }
    </Show>
  )
}

const reloadChapterPage = () => location.replace('/')
function useReloadOnChapterChange(processId: () => number | undefined) {
  let chapterAtPageLoad: string | undefined
  createEffect(processId, (pid) => {
    if (pid === undefined) return undefined
    const controller = new AbortController()
    api
      .action(ChaptersAction, null, { signal: controller.signal })
      .then((chapters) => {
        if (chapterAtPageLoad === undefined) chapterAtPageLoad = chapters.active
        else if (chapterAtPageLoad !== chapters.active) reloadChapterPage()
      })
      .catch(keepLast)
    return () => controller.abort()
  })
}

export function useWakeUp(open: () => Promise<void>) {
  const system = useSystem()
  createEffect(
    () => system() !== undefined,
    (ready) => {
      if (!ready || !sessionStorage.getItem(OPEN_ULTIMATE_AFTER_WAKE_RELOAD)) return
      sessionStorage.removeItem(OPEN_ULTIMATE_AFTER_WAKE_RELOAD)
      void writingAs('app', open).catch(keepLast)
    },
  )
}

export function ChaptersDialog() {
  const [open, setOpen] = useDialog(chaptersDialog)
  return (
    <Dialog onOpenChange={setOpen} open={open()}>
      <DialogContent
        class="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] gap-0 overflow-y-auto p-0 sm:max-w-[28rem]"
        data-dream-chapters
      >
        <Show when={open()}>
          <ChaptersBody />
        </Show>
      </DialogContent>
    </Dialog>
  )
}

function ChaptersBody() {
  const chapters = useChapters()
  const busy = useBusyElsewhere()
  const system = useSystem()
  const [confirm, setConfirm] = createSignal<string>()
  const [switching, setSwitching] = createSignal<string>()
  const [failure, setFailure] = createSignal<string>()
  const go = async (name: string, number: number) => {
    setSwitching(name)
    setFailure(undefined)
    const refused = await switchChapter(chapterLabel(number, name), name, system()?.process.pid)
    setSwitching(undefined)
    setConfirm(undefined)
    if (refused) setFailure(refused)
  }
  return (
    <>
      <div class="space-y-2 px-6 pt-6 pb-4">
        <DialogTitle class="flex items-center gap-2 text-base">
          <LibraryIcon class="size-4 text-brand" />
          Chapters
        </DialogTitle>
        <DialogDescription class="text-[13px] leading-relaxed text-muted-foreground">
          Each chapter is its own database. A dream starts a new one with what I learned; the others
          stay on disk, and you can switch back to any of them.
        </DialogDescription>
      </div>
      <ol class="border-y border-border/60 py-1" data-dream-chapter-list>
        {!chapters() && (
          <li class="flex items-center gap-2 px-6 py-2 text-[12px] text-muted-foreground">
            <LoaderCircleIcon class="size-3 motion-safe:animate-spin" />
            Reading chapters…
          </li>
        )}
        <For each={chapters()?.chapters.toReversed()} keyed={(chapter) => chapter.name}>
          {(chapter) => {
            const active = () => chapter().name === chapters()?.active
            const newest = () => chapter().name === chapters()?.newest
            const asking = () => confirm() === chapter().name
            return (
              <li
                class={cn('px-6 py-2', active() && 'bg-muted/40')}
                data-active={active() || undefined}
                data-chapter={chapter().name}
              >
                <div class="flex items-center gap-3">
                  <span class="w-5 shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                    {chapter().number}
                  </span>
                  <div class="min-w-0 flex-1">
                    <p class="truncate font-mono text-[12.5px] text-foreground">{chapter().name}</p>
                    <p class="font-mono text-[10.5px] text-muted-foreground">
                      {chapter().createdAt
                        ? `began ${new Date(chapter().createdAt!).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
                        : 'the first chapter'}
                      {newest() && !active() && ' · newest'}
                    </p>
                  </div>
                  {active() ? (
                    <span class="flex items-center gap-1.5 font-mono text-[11px] text-brand">
                      <span class="size-1.5 rounded-full bg-brand" />
                      you're here
                    </span>
                  ) : (
                    !asking() && (
                      <Button
                        class="h-6"
                        aria-label={`Choose chapter ${chapter().name}`}
                        disabled={busy().length > 0 || switching() !== undefined}
                        onClick={() => {
                          setFailure(undefined)
                          setConfirm(chapter().name)
                        }}
                        size="xs"
                        variant="ghost"
                      >
                        Switch
                        <ArrowRightIcon />
                      </Button>
                    )
                  )}
                </div>
                {asking() && (
                  <div class="mt-2 ml-8 flex flex-wrap items-center gap-2 text-[12px]">
                    <span class="mr-auto text-muted-foreground">
                      Restart into it? This chapter stays as it is.
                    </span>
                    <Button
                      class="h-6"
                      disabled={switching() !== undefined}
                      onClick={() => setConfirm(undefined)}
                      size="xs"
                      variant="ghost"
                    >
                      Stay
                    </Button>
                    <Button
                      class="h-6"
                      data-dream-switch={chapter().name}
                      disabled={busy().length > 0 || switching() !== undefined}
                      onClick={() => go(chapter().name, chapter().number)}
                      size="xs"
                      variant="outline"
                    >
                      {switching() === chapter().name && (
                        <LoaderCircleIcon class="motion-safe:animate-spin" />
                      )}
                      Switch to {chapter().name}
                    </Button>
                  </div>
                )}
              </li>
            )
          }}
        </For>
      </ol>
      <footer class="space-y-2 bg-muted/30 px-6 py-3">
        {busy().length > 0 && <BusyBlocker busy={busy()} />}
        <Show when={failure()}>{(text) => <Refusal text={text()} />}</Show>
        {!busy().length && !failure() && (
          <p class="text-[12px] text-muted-foreground">
            Switching restarts the server; nothing in either chapter changes.
          </p>
        )}
      </footer>
    </>
  )
}

export function BusyBlocker(props: {
  busy: { id: ConversationId; title: string }[]
  onGo?: () => void
}) {
  const [, setChapters] = useDialog(chaptersDialog)
  return (
    <div class="space-y-1" data-dream-blocked="busy">
      <p class="text-[12px] leading-relaxed text-muted-foreground">
        <span class="text-foreground">Wait for these to finish first</span> — their work would stop
        halfway in this chapter.
      </p>
      <ul class="space-y-0.5 font-mono text-[11px]">
        <For each={props.busy} keyed={(item) => item.id}>
          {(item) => (
            <li>
              <Button
                size={null}
                variant={null}
                class="-mx-1 flex max-w-full min-w-0 items-center gap-1.5 rounded-sm px-1 py-0.5 font-normal hover:bg-accent"
                onClick={() => {
                  setChapters(false)
                  props.onGo?.()
                  switchConversation(item().id)
                  showSurface('agent')
                }}
                type="button"
              >
                <span class="size-1.5 shrink-0 rounded-full bg-brand motion-safe:animate-pulse-dot" />
                <ConversationRef id={item().id} title={item().title} />
              </Button>
            </li>
          )}
        </For>
      </ul>
    </div>
  )
}

export function Refusal(props: { text: string }) {
  return (
    <p class="text-[12px] leading-relaxed" data-dream-refused role="alert">
      <span class="text-error">Didn't switch.</span>{' '}
      <span class="text-muted-foreground">{props.text}</span>
    </p>
  )
}

export function OlderChapterBanner() {
  const chapters = useChapters()
  const [, setChapters] = useDialog(chaptersDialog)
  const older = () => chapters()?.active !== chapters()?.newest && chapters()
  return (
    <Show when={older()}>
      {(chapter) => (
        <div
          class="mx-2 mb-1.5 rounded-md border border-border/70 border-l-2 border-l-brand/50 bg-muted/30 px-2.5 py-2"
          data-dream-older-chapter
        >
          <p class="flex items-start gap-1.5 text-[11.5px] leading-snug text-muted-foreground">
            <MoonIcon class="mt-px size-3 shrink-0 text-brand" />
            <span>
              You're in{' '}
              <span class="text-foreground">
                {chapterLabel(chapter().number, chapter().active)}
              </span>{' '}
              — not the newest.
            </span>
          </p>
          <Button
            size={null}
            variant={null}
            class="mt-1 ml-[18px] flex items-center gap-1 font-mono text-[11px] font-normal text-foreground/85 hover:text-foreground"
            onClick={() => setChapters(true)}
            type="button"
          >
            Switch to {chapter().newest}
            <ArrowRightIcon class="size-3" />
          </Button>
        </div>
      )}
    </Show>
  )
}

export function OlderChapterStatus() {
  const chapters = useChapters()
  const [, setChapters] = useDialog(chaptersDialog)
  const older = () => chapters()?.active !== chapters()?.newest && chapters()
  return (
    <Show when={older()}>
      {(chapter) => (
        <StatusButton
          class="text-brand/90"
          data-dream-older-status
          onClick={() => setChapters(true)}
          title={`${chapterLabel(chapter().number, chapter().active)} is open; ${chapter().newest} is the newest`}
          type="button"
        >
          <MoonIcon class="size-3" />
          older chapter
        </StatusButton>
      )}
    </Show>
  )
}
