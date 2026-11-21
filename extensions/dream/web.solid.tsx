/** @jsxImportSource @solidjs/web */
import { LibraryIcon, MoonIcon } from '@lucide/solid'
import { Show, createMemo } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { StatusButton } from '@/components/ui/status-trigger.solid.tsx'
import {
  ROOT,
  attention,
  defineWebExtension,
  provide,
  showSurface,
  switchConversation,
  useAgent,
  useConversation,
  useConversationId,
  useDialog,
  useDocOf,
  useModels,
} from '@/sdk/solid'
import type { EntryRecord } from '@/sdk/solid'
import { MemoryHeader } from '../lineage/ui.solid.tsx'
import { StandingDoc, talkToUltimate } from '../subagents/ui.solid.tsx'
import {
  chapterLabel,
  ChaptersDialog,
  chaptersDialog,
  OlderChapterBanner,
  OlderChapterStatus,
  SwitchVeil,
  useChapters,
  useWakeUp,
} from './chapters.solid.tsx'
import { MorningCard } from './morning.solid.tsx'
import { DreamDialog, dreamDialog } from './modal.solid.tsx'
import { AwakeSection, useAwake } from './awake.solid.tsx'
import { AwakeDialog, DreamStatus, NextDialog } from './pinned.solid.tsx'
import { ReadyCard, RequestedCard } from './requested.solid.tsx'
import { DreamDoc } from './refs.ts'
import { PreparedCard } from './sleep.solid.tsx'

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
  const id = useConversationId()
  const standing = useDocOf(() => ROOT, StandingDoc)
  const doc = useDocOf(() => ROOT, DreamDoc)
  const awake = useAwake()
  const conversation = useConversation()
  const active = createMemo(() => {
    const ultimate = standing()?.ultimate
    return (
      ultimate !== undefined &&
      id() === ultimate &&
      doc() !== undefined &&
      !awake() &&
      conversation().entries.some((entry) => entry.kind === 'pi.compaction')
    )
  })
  return (
    <Show when={active()}>
      <DreamHint />
    </Show>
  )
}

function DreamHint() {
  const conversation = useConversation()
  const agent = useAgent()
  const models = useModels()
  const [, setDream] = useDialog(dreamDialog)
  const active = createMemo(() => {
    const current = agent().model
    const window = models()?.models.find(
      (model) => model.provider === current?.provider && model.id === current.modelId,
    )?.contextWindow
    return (
      !!window && (contextShare(conversation().entries, window) ?? 0) > CONTEXT_SHARE_WORTH_DREAMING
    )
  })
  return (
    <Show when={active()}>
      <StatusButton
        class="text-muted-foreground"
        data-dream-hint
        onClick={() => setDream(true)}
        title="@ultimate has learned a lot since its last dream: see what dreaming does"
      >
        <MoonIcon class="size-3 text-brand/80" />
        Time to dream?
      </StatusButton>
    </Show>
  )
}

function DreamButton() {
  const [, setDream] = useDialog(dreamDialog)
  const [, setChapters] = useDialog(chaptersDialog)
  const chapters = useChapters()
  return (
    <div class="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
      <Show
        when={(chapters()?.chapters.length ?? 0) > 1 && chapters()}
        fallback={
          <span class="text-[11px] text-muted-foreground">What every new branch starts from</span>
        }
      >
        {(chapter) => (
          <Button
            class="-mx-1.5 flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[11px] font-normal text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            data-dream-chapters-open
            onClick={() => setChapters(true)}
            size={null}
            title="This memory belongs to the open chapter: see every chapter, or switch"
            variant={null}
          >
            <LibraryIcon class="size-3 shrink-0" />
            <span class="truncate">{chapterLabel(chapter().number, chapter().active)}</span>
          </Button>
        )}
      </Show>
      <Button
        class="-mx-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[11px] font-normal text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        data-dream-open
        onClick={() => setDream(true)}
        size={null}
        title="Process what Ultimate learned: a journal and proposals for you to decide"
        variant={null}
      >
        <MoonIcon class="size-3 text-brand" />
        Dream
      </Button>
    </div>
  )
}

function WakeUp() {
  useWakeUp(() => talkToUltimate({ showSurface, switchConversation }))
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
  provides: [provide(MemoryHeader, DreamButton)],
})
