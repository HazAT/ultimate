import { ROOT } from '@/sdk'
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
import { AwakeSection, useAwake } from './awake.tsx'
import { AwakeDialog, DreamStatus, NextDialog } from './pinned.tsx'
import { ReadyCard, RequestedCard } from './requested.tsx'
import { DreamDoc } from './refs.ts'
import { PreparedCard } from './sleep.tsx'

const CONTEXT_SHARE_WORTH_DREAMING = 0.5

function contextShare(entries: readonly EntryRecord[], window: number) {
  let latestCompactionOrReset = -1
  let latestAnswer = -1
  let used = 0
  for (const entry of entries) {
    if (entry.kind === 'pi.compaction' || entry.kind === 'pi.reset')
      latestCompactionOrReset = Math.max(latestCompactionOrReset, entry.id)
    const model = entry.model?.[0]
    if (entry.kind === 'pi.assistant' && model?.role === 'assistant' && entry.id > latestAnswer) {
      latestAnswer = entry.id
      used = model.usage.input + model.usage.cacheRead + model.usage.cacheWrite
    }
  }
  return latestAnswer > latestCompactionOrReset ? used / window : undefined
}

function TimeToDream() {
  const id = useConversation((conversation) => conversation.id)
  const ultimate = useDocOf(ROOT, StandingDoc)?.ultimate
  const doc = useDocOf(ROOT, DreamDoc)
  const awake = useAwake()
  const compacted = useConversation((conversation) =>
    conversation.entries.some((entry) => entry.kind === 'pi.compaction'),
  )
  if (ultimate === undefined || id !== ultimate || doc === undefined || awake || !compacted)
    return null
  return <DreamHint />
}

function DreamHint() {
  const { entries, agent } = useConversation()
  const models = useModels()
  const actions = useUltimate()
  const window = models?.models.find(
    (model) => model.provider === agent.model?.provider && model.id === agent.model.modelId,
  )?.contextWindow
  const share = window ? contextShare(entries, window) : undefined
  if (share === undefined || share <= CONTEXT_SHARE_WORTH_DREAMING) return null
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

function useDreamButton() {
  const actions = useUltimate()
  const chapters = useChapters()
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
      {chapters && chapters.chapters.length > 1 ? (
        <button
          className="-mx-1.5 flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          data-dream-chapters-open
          onClick={() => actions.open(chaptersDialog)}
          title="This memory belongs to the open chapter: see every chapter, or switch"
          type="button"
        >
          <LibraryIcon className="size-3 shrink-0" />
          <span className="truncate">{chapterLabel(chapters.number, chapters.active)}</span>
        </button>
      ) : (
        <span className="text-[11px] text-muted-foreground">What every new branch starts from</span>
      )}
      <button
        className="-mx-1.5 flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
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

function WakeUp() {
  const actions = useUltimate()
  useWakeUp(() => talkToUltimate(actions))
  return null
}

export default defineWebExtension({
  entries: {
    'dream.requested': RequestedCard,
    'dream.ready': ReadyCard,
    'dream.prepared': attention(PreparedCard),
    'dream.chapter': MorningCard,
  },
  slots: {
    'sidebar.top': [
      { component: OlderChapterBanner, order: -30 },
      { component: AwakeSection, order: -25 },
    ],
    'statusline.right': [
      { component: DreamStatus, order: -10, phone: true },
      TimeToDream,
      OlderChapterStatus,
    ],
    overlay: [DreamDialog, AwakeDialog, NextDialog, ChaptersDialog, SwitchVeil, WakeUp],
  },
  commands: [
    { id: 'dream.open', title: 'Dream…', run: (context) => context.open(dreamDialog) },
    { id: 'dream.chapters', title: 'Chapters…', run: (context) => context.open(chaptersDialog) },
  ],
  provides: [provide(MemoryHeader, useDreamButton)],
})
