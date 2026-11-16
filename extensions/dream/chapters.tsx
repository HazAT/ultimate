import type { ConversationId } from '@earendil-works/pi-durable'
import { ROOT } from '@/sdk'
import { ArrowRightIcon, LibraryIcon, LoaderCircleIcon, MoonIcon, RotateCwIcon } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  ActionError,
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
  useUltimate,
} from '@/sdk'
import { ConversationRef } from '../conversations/ui.tsx'
import { AsleepAction, ChaptersAction, DreamDoc, SwitchAction } from './refs.ts'
import { busyElsewhere } from './types.ts'

export const chapterLabel = (number: number, name: string) => `Chapter ${number} · ${name}`

export const CHAPTER_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/

export const chaptersDialog = 'dream.chapters'

export function useChapters() {
  return useAction(ChaptersAction, null, { onError: keepLast }).data
}

export function useBusyElsewhere() {
  return busyElsewhere(useConversations())
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

let pendingUntilReload: Pending | undefined
const listeners = new Set<() => void>()
const setPending = (next: Pending | undefined) => {
  pendingUntilReload = next
  for (const listener of listeners) listener()
}
const usePending = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    () => pendingUntilReload,
  )

const OPEN_ULTIMATE_AFTER_WAKE_RELOAD = 'ultimate.dream.wake'

export const cutOff = (error: unknown) => error instanceof ActionError && error.status === 0

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
  const ours = usePending()
  const system = useSystem()
  const connection = useConnection()
  const doc = useDocOf(ROOT, DreamDoc)
  const sleep = doc?.sleep?.phase === 'switching' ? doc.sleep : undefined
  const current = useChapters()
  const now = useNow(1000, ours !== undefined)
  const pid = system?.process.pid
  useEffect(() => {
    if (sleep && !pendingUntilReload && current)
      setPending({
        to: chapterLabel(current.chapters.length + 1, sleep.chapter),
        verb: 'asleep',
        pid,
        since: Date.now(),
      })
  }, [sleep, current, pid])
  useEffect(() => {
    const restartRefused =
      pendingUntilReload?.verb === 'asleep' &&
      pendingUntilReload.pid === pid &&
      doc !== undefined &&
      !sleep
    if (restartRefused) setPending(undefined)
  }, [doc, sleep, pid])
  useEffect(() => {
    if (
      !pendingUntilReload ||
      pid === undefined ||
      pendingUntilReload.pid === undefined ||
      pendingUntilReload.failed
    )
      return
    const error = system?.process.activationError
    if (connection.status !== 'open') {
      if (!pendingUntilReload.dropped) setPending({ ...pendingUntilReload, dropped: { error } })
      return
    }
    if (pid === pendingUntilReload.pid) {
      const rolledBackToSameProcess =
        pendingUntilReload.dropped &&
        error !== undefined &&
        error !== pendingUntilReload.dropped.error
      if (rolledBackToSameProcess) setPending({ ...pendingUntilReload, failed: true })
      return
    }
    if (pendingUntilReload.verb === 'asleep')
      sessionStorage.setItem(OPEN_ULTIMATE_AFTER_WAKE_RELOAD, '1')
    reloadChapterPage()
  }, [pid, connection.status, system])
  useReloadOnChapterChange(pid)
  if (!ours) return null
  if (ours.failed)
    return (
      <div
        className="fixed inset-0 z-[100] flex animate-fade-in items-center justify-center bg-background/95 backdrop-blur-sm"
        data-dream-veil="failed"
        role="alert"
      >
        <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
          <MoonIcon className="size-6 text-muted-foreground" />
          <p className="text-[15px] text-foreground">The switch didn't happen</p>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            The new server failed to start and the old one took over again: nothing moved. The
            reason is in the supervisor's output.
          </p>
          <Button onClick={() => setPending(undefined)} size="xs" variant="outline">
            Stay here
          </Button>
        </div>
      </div>
    )
  const slow = now - ours.since > 90_000
  return (
    <div
      aria-live="polite"
      className="fixed inset-0 z-[100] flex animate-fade-in items-center justify-center bg-background/95 backdrop-blur-sm"
      data-dream-veil={ours.verb}
      role="status"
    >
      <div className="flex max-w-sm flex-col items-center gap-4 px-6 text-center">
        <MoonIcon
          className="size-6 text-brand motion-safe:animate-pulse-dot"
          style={{ animationDuration: '3.2s' }}
        />
        <div className="space-y-1.5">
          <p className="text-[15px] text-foreground">
            {ours.verb === 'asleep' ? 'Falling asleep' : 'Switching chapters'}
          </p>
          <p className="font-mono text-[12px] text-muted-foreground">
            {ours.verb === 'asleep' ? 'waking up in ' : 'to '}
            <span className="text-foreground/90">{ours.to}</span>
          </p>
        </div>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          The server restarts into that chapter. This page reconnects by itself.
        </p>
        {slow && (
          <div className="flex flex-col items-center gap-2 pt-1">
            <p className="text-[12px] text-warning">This is taking longer than it should.</p>
            <Button onClick={() => location.reload()} size="xs" variant="outline">
              <RotateCwIcon />
              Reload the page
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

const reloadChapterPage = () => location.replace('/')
function useReloadOnChapterChange(pid: number | undefined) {
  const chapterAtPageLoad = useRef<string>(undefined)
  useEffect(() => {
    if (pid === undefined) return undefined
    const controller = new AbortController()
    api
      .action(ChaptersAction, null, { signal: controller.signal })
      .then((chapters) => {
        if (chapterAtPageLoad.current === undefined) chapterAtPageLoad.current = chapters.active
        else if (chapterAtPageLoad.current !== chapters.active) reloadChapterPage()
      })
      .catch(keepLast)
    return () => controller.abort()
  }, [pid])
}

export function useWakeUp(open: () => Promise<void>) {
  const system = useSystem()
  useEffect(() => {
    if (!system || !sessionStorage.getItem(OPEN_ULTIMATE_AFTER_WAKE_RELOAD)) return
    sessionStorage.removeItem(OPEN_ULTIMATE_AFTER_WAKE_RELOAD)
    void open()
  }, [system, open])
}

export function ChaptersDialog() {
  const [open, setOpen] = useDialog(chaptersDialog)
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] gap-0 overflow-y-auto p-0 sm:max-w-[28rem]"
        data-dream-chapters
      >
        {open && <ChaptersBody />}
      </DialogContent>
    </Dialog>
  )
}

function ChaptersBody() {
  const chapters = useChapters()
  const busy = useBusyElsewhere()
  const pid = useSystem()?.process.pid
  const [confirm, setConfirm] = useState<string>()
  const [switching, setSwitching] = useState<string>()
  const [failure, setFailure] = useState<string>()
  const go = async (name: string, number: number) => {
    setSwitching(name)
    setFailure(undefined)
    const refused = await switchChapter(chapterLabel(number, name), name, pid)
    setSwitching(undefined)
    setConfirm(undefined)
    if (refused) setFailure(refused)
  }
  return (
    <>
      <div className="space-y-2 px-6 pt-6 pb-4">
        <DialogTitle className="flex items-center gap-2 text-base">
          <LibraryIcon className="size-4 text-brand" />
          Chapters
        </DialogTitle>
        <DialogDescription className="text-[13px] leading-relaxed text-muted-foreground">
          Each chapter is its own database. A dream starts a new one with what I learned; the others
          stay on disk, and you can switch back to any of them.
        </DialogDescription>
      </div>
      <ol className="border-y border-border/60 py-1" data-dream-chapter-list>
        {!chapters && (
          <li className="flex items-center gap-2 px-6 py-2 text-[12px] text-muted-foreground">
            <LoaderCircleIcon className="size-3 motion-safe:animate-spin" />
            Reading chapters…
          </li>
        )}
        {chapters?.chapters.toReversed().map((chapter) => {
          const active = chapter.name === chapters.active
          const newest = chapter.name === chapters.newest
          const asking = confirm === chapter.name
          return (
            <li
              className={cn('px-6 py-2', active && 'bg-muted/40')}
              data-active={active || undefined}
              data-chapter={chapter.name}
              key={chapter.name}
            >
              <div className="flex items-center gap-3">
                <span className="w-5 shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                  {chapter.number}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[12.5px] text-foreground">{chapter.name}</p>
                  <p className="font-mono text-[10.5px] text-muted-foreground">
                    {chapter.createdAt
                      ? `began ${new Date(chapter.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
                      : 'the first chapter'}
                    {newest && !active && ' · newest'}
                  </p>
                </div>
                {active ? (
                  <span className="flex items-center gap-1.5 font-mono text-[11px] text-brand">
                    <span className="size-1.5 rounded-full bg-brand" />
                    you're here
                  </span>
                ) : (
                  !asking && (
                    <Button
                      className="h-6"
                      disabled={busy.length > 0 || switching !== undefined}
                      onClick={() => {
                        setFailure(undefined)
                        setConfirm(chapter.name)
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
              {asking && (
                <div className="mt-2 ml-8 flex flex-wrap items-center gap-2 text-[12px]">
                  <span className="mr-auto text-muted-foreground">
                    Restart into it? This chapter stays as it is.
                  </span>
                  <Button
                    className="h-6"
                    disabled={switching !== undefined}
                    onClick={() => setConfirm(undefined)}
                    size="xs"
                    variant="ghost"
                  >
                    Stay
                  </Button>
                  <Button
                    className="h-6"
                    data-dream-switch={chapter.name}
                    disabled={busy.length > 0 || switching !== undefined}
                    onClick={() => void go(chapter.name, chapter.number)}
                    size="xs"
                    variant="outline"
                  >
                    {switching === chapter.name && (
                      <LoaderCircleIcon className="motion-safe:animate-spin" />
                    )}
                    Switch to {chapter.name}
                  </Button>
                </div>
              )}
            </li>
          )
        })}
      </ol>
      <footer className="space-y-2 bg-muted/30 px-6 py-3">
        {busy.length > 0 && <BusyBlocker busy={busy} />}
        {failure && <Refusal text={failure} />}
        {!busy.length && !failure && (
          <p className="text-[12px] text-muted-foreground">
            Switching restarts the server; nothing in either chapter changes.
          </p>
        )}
      </footer>
    </>
  )
}

export function BusyBlocker({
  busy,
  onGo,
}: {
  busy: { id: ConversationId; title: string }[]
  onGo?: () => void
}) {
  const actions = useUltimate()
  return (
    <div className="space-y-1" data-dream-blocked="busy">
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        <span className="text-foreground">Wait for these to finish first</span> — their work would
        stop halfway in this chapter.
      </p>
      <ul className="space-y-0.5 font-mono text-[11px]">
        {busy.map((item) => (
          <li key={item.id}>
            <button
              className="-mx-1 flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm px-1 py-0.5 hover:bg-accent"
              onClick={() => {
                actions.close(chaptersDialog)
                onGo?.()
                actions.switchConversation(item.id)
                actions.showSurface('agent')
              }}
              type="button"
            >
              <span className="size-1.5 shrink-0 rounded-full bg-brand motion-safe:animate-pulse-dot" />
              <ConversationRef id={item.id} title={item.title} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function Refusal({ text }: { text: string }) {
  return (
    <p className="text-[12px] leading-relaxed" data-dream-refused role="alert">
      <span className="text-error">Didn't switch.</span>{' '}
      <span className="text-muted-foreground">{text}</span>
    </p>
  )
}

export function OlderChapterBanner() {
  const chapters = useChapters()
  const actions = useUltimate()
  if (!chapters || chapters.active === chapters.newest) return null
  const newest = chapters.chapters.at(-1)!
  return (
    <div
      className="mx-2 mb-1.5 rounded-md border border-border/70 border-l-2 border-l-brand/50 bg-muted/30 px-2.5 py-2"
      data-dream-older-chapter
    >
      <p className="flex items-start gap-1.5 text-[11.5px] leading-snug text-muted-foreground">
        <MoonIcon className="mt-px size-3 shrink-0 text-brand" />
        <span>
          You're in{' '}
          <span className="text-foreground">{chapterLabel(chapters.number, chapters.active)}</span>{' '}
          — not the newest.
        </span>
      </p>
      <button
        className="mt-1 ml-[18px] flex cursor-pointer items-center gap-1 font-mono text-[11px] text-foreground/85 hover:text-foreground"
        onClick={() => actions.open(chaptersDialog)}
        type="button"
      >
        Switch to {newest.name}
        <ArrowRightIcon className="size-3" />
      </button>
    </div>
  )
}

export function OlderChapterStatus() {
  const chapters = useChapters()
  const actions = useUltimate()
  if (!chapters || chapters.active === chapters.newest) return null
  return (
    <button
      className="-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 text-brand/90 transition-colors hover:bg-accent hover:text-foreground"
      data-dream-older-status
      onClick={() => actions.open(chaptersDialog)}
      title={`${chapterLabel(chapters.number, chapters.active)} is open; ${chapters.newest} is the newest`}
      type="button"
    >
      <MoonIcon className="size-3" />
      older chapter
    </button>
  )
}
