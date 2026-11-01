import { LibraryIcon, MoonIcon } from 'lucide-react'
import {
  attention,
  defineWebExtension,
  provide,
  useConversation,
  useDocOf,
  useModels,
  useUltimate,
} from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { MemoryHeader } from '../lineage/ui.tsx'
import { StandingDoc, talkToUltimate } from '../subagents/ui.tsx'
import {
  chapterLabel,
  ChaptersDialog,
  chaptersDialog,
  OlderChapterBanner,
  OlderChapterStatus,
  SwitchVeil,
  useChapters,
  useWakeUp,
} from './chapters.tsx'
import { MorningCard } from './morning.tsx'
import { DreamDialog, dreamDialog } from './modal.tsx'
import { DreamStatus, NextDialog } from './pinned.tsx'
import { RequestedCard } from './requested.tsx'
import { DreamDoc } from './refs.ts'
import { PreparedCard } from './sleep.tsx'

/** Above this share of its context window, a compacted @ultimate has lived long enough to be worth a dream. */
const FULL = 0.5

/**
 * The share of the context window the latest response was sent with, or undefined when a compaction or reset came
 * after it (the context is fresh then) or nothing answered yet.
 */
function contextShare(entries: readonly EntryRecord[], window: number) {
  let marker = -1
  let answered = -1
  let used = 0
  for (const entry of entries) {
    if (entry.kind === 'pi.compaction' || entry.kind === 'pi.reset')
      marker = Math.max(marker, entry.id)
    const model = entry.model?.[0]
    if (entry.kind === 'pi.assistant' && model?.role === 'assistant' && entry.id > answered) {
      answered = entry.id
      used = model.usage.input + model.usage.cacheRead + model.usage.cacheWrite
    }
  }
  return answered > marker ? used / window : undefined
}

/**
 * A quiet hint in the status line when @ultimate is shown, has compacted at least once and is past half its context
 * again, and no fresh chapter is prepared: a good time to dream. Clicking it explains what a dream does.
 */
function TimeToDream() {
  const { id, entries, agent } = useConversation()
  const ultimate = useDocOf(1, StandingDoc)?.ultimate
  const doc = useDocOf(1, DreamDoc)
  const models = useModels()
  const actions = useUltimate()
  if (ultimate === undefined || id !== ultimate || doc === undefined) return null
  if (doc?.prepared && doc.sleep?.phase !== 'asleep') return null
  if (!entries.some((entry) => entry.kind === 'pi.compaction')) return null
  const window = models?.models.find(
    (model) => model.provider === agent.model?.provider && model.id === agent.model.modelId,
  )?.contextWindow
  const share = window ? contextShare(entries, window) : undefined
  if (share === undefined || share <= FULL) return null
  return (
    <button
      className="-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      data-dream-hint
      onClick={() => actions.open(dreamDialog)}
      title="@ultimate has learned a lot since its last dream: see what dreaming does"
      type="button"
    >
      <MoonIcon className="size-3 text-brand/80" />
      Time to dream?
    </button>
  )
}

/**
 * The Memory surface's header: which chapter this memory belongs to (a way to the others), and the Dream button, since
 * dreaming distils this memory, among other things.
 */
function useDreamButton() {
  const actions = useUltimate()
  const chapters = useChapters()
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
      {chapters && chapters.chapters.length > 1 ? (
        <button
          className="-mx-1.5 flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          data-dream-chapters-open
          onClick={() => actions.open(chaptersDialog)}
          title="This memory belongs to the open chapter: see every chapter, or switch"
          type="button"
        >
          <LibraryIcon className="size-3 shrink-0" />
          <span className="truncate">{chapterLabel(chapters.number, chapters.active)}</span>
        </button>
      ) : (
        <span className="text-[0.6875rem] text-muted-foreground">
          What every new branch starts from
        </span>
      )}
      <button
        className="-mx-1.5 flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        data-dream-open
        onClick={() => actions.open(dreamDialog)}
        title="Process what Ultimate learned: a journal and proposals for you to decide"
        type="button"
      >
        <MoonIcon className="size-3 text-brand" />
        Dream
      </button>
    </div>
  )
}

/** After a Fall asleep the reloaded page opens @ultimate, where the morning card waits. */
function WakeUp() {
  const actions = useUltimate()
  useWakeUp(() => talkToUltimate(actions))
  return null
}

export default defineWebExtension({
  entries: {
    'dream.requested': RequestedCard,
    'dream.prepared': attention(PreparedCard),
    'dream.chapter': MorningCard,
  },
  slots: {
    'sidebar.top': [{ component: OlderChapterBanner, order: -30 }],
    'statusline.right': [
      { component: DreamStatus, order: -10, phone: true },
      TimeToDream,
      OlderChapterStatus,
    ],
    overlay: [DreamDialog, NextDialog, ChaptersDialog, SwitchVeil, WakeUp],
  },
  commands: [
    { id: 'dream.open', title: 'Dream…', run: (context) => context.open(dreamDialog) },
    { id: 'dream.chapters', title: 'Chapters…', run: (context) => context.open(chaptersDialog) },
  ],
  provides: [provide(MemoryHeader, useDreamButton)],
})
