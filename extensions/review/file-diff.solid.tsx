import {
  DIFFS_TAG_NAME,
  VirtualizedFileDiff,
  areOptionsEqual,
  getLineAnnotationName,
} from '@pierre/diffs'
import type {
  DiffLineAnnotation,
  FileDiffMetadata,
  FileDiffOptions,
  SelectedLineRange,
  Virtualizer,
} from '@pierre/diffs'
import { Dynamic } from '@solidjs/web'
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import { Composer, DraftCard } from './comment.solid.tsx'
import type { Draft, Drafts } from './drafts.ts'
import { commentRange } from './lines.ts'
import type { ReviewTarget } from './link-state.ts'

export type Writing = { file: string; range: SelectedLineRange; id?: string }

const sideOf = (side: 'old' | 'new') => (side === 'old' ? 'deletions' : 'additions')
const draftLine = (draft: Draft): DiffLineAnnotation => ({
  side: sideOf(draft.side),
  lineNumber: draft.end,
})
const writingLine = (range: SelectedLineRange): DiffLineAnnotation => ({
  side: range.endSide ?? range.side ?? 'additions',
  lineNumber: Math.max(range.start, range.end),
})

export function CommentedDiff(props: {
  meta: FileDiffMetadata
  options: FileDiffOptions<undefined, undefined>
  virtualizer: Virtualizer
  drafts: Draft[]
  writing?: Writing
  marked?: ReviewTarget
  onWrite: (writing: Writing | undefined) => void
  update: (change: (drafts: Drafts) => Drafts) => boolean
}) {
  const mine = createMemo(() =>
    props.writing?.file === props.meta.name ? props.writing : undefined,
  )
  const drafts = createMemo(() => props.drafts.filter((draft) => draft.id !== mine()?.id))
  const writingAnnotation = createMemo(() => {
    const writing = mine()
    return writing ? writingLine(writing.range) : undefined
  })
  const annotations = createMemo(() => {
    const lines = drafts().map(draftLine)
    const writing = writingAnnotation()
    if (writing) lines.push(writing)
    return lines
  })
  const [dragging, setDragging] = createSignal<SelectedLineRange | null>(null)
  const selected = createMemo<SelectedLineRange | null>(() => {
    const marked = props.marked
    return (
      dragging() ??
      mine()?.range ??
      (marked ? { start: marked.line, end: marked.line, side: sideOf(marked.side ?? 'new') } : null)
    )
  })
  const onWrite = (range: SelectedLineRange | null) =>
    props.onWrite(range ? { file: props.meta.name, range } : undefined)
  const options = createMemo<FileDiffOptions<undefined, undefined>>(() => ({
    ...props.options,
    controlledSelection: true,
    enableLineSelection: true,
    enableGutterUtility: true,
    onLineSelectionStart: setDragging,
    onLineSelectionChange: setDragging,
    onLineSelectionEnd: (range) => {
      setDragging(null)
      onWrite(range)
    },
    onGutterUtilityClick: onWrite,
  }))
  let container: HTMLElement
  let instance: VirtualizedFileDiff | undefined
  onCleanup(() => instance?.cleanUp())
  createEffect(
    () => ({
      options: options(),
      virtualizer: props.virtualizer,
      fileDiff: props.meta,
      lineAnnotations: annotations(),
    }),
    ({ options: next, virtualizer, fileDiff, lineAnnotations }) => {
      if (!instance) {
        instance = new VirtualizedFileDiff(next, virtualizer, undefined, undefined, true)
        instance.hydrate({ fileDiff, fileContainer: container, lineAnnotations })
        return
      }
      const forceRender = !areOptionsEqual(instance.options, next)
      instance.setOptions(next)
      instance.render({ fileDiff, lineAnnotations, forceRender })
    },
  )
  createEffect(selected, (range) => {
    instance?.setSelectedLines(range)
  })
  const composerKey = createMemo(() => {
    const writing = mine()
    return writing && `${writing.id ?? 'new'}:${writing.range.start}:${writing.range.end}`
  })
  const editing = createMemo(() => props.drafts.find((draft) => draft.id === mine()?.id))
  const comment = () => commentRange(props.meta, mine()!.range)
  const submit = (text: string) => {
    const existing = editing()
    const edited = comment()
    const kept = props.update((all) => ({
      ...all,
      comments: existing
        ? all.comments.map((draft) => (draft.id === existing.id ? { ...draft, text } : draft))
        : [...all.comments, { ...edited, text, id: crypto.randomUUID() }],
    }))
    if (kept) props.onWrite(undefined)
    return kept
  }
  return (
    <Dynamic
      component={DIFFS_TAG_NAME}
      class="block overflow-hidden rounded-md border border-border/70"
      ref={(element: HTMLElement) => {
        container = element
      }}
    >
      <For each={drafts()} keyed={(draft) => draft.id}>
        {(draft) => (
          <div slot={getLineAnnotationName(draftLine(draft()))}>
            <DraftCard
              comment={draft()}
              onDelete={() => {
                const id = draft().id
                props.update((all) => ({
                  ...all,
                  comments: all.comments.filter((item) => item.id !== id),
                }))
              }}
              onEdit={() => {
                const { id, start, end, side } = draft()
                props.onWrite({
                  file: props.meta.name,
                  range: { start, end, side: sideOf(side) },
                  id,
                })
              }}
            />
          </div>
        )}
      </For>
      <Show when={composerKey()} keyed>
        <div slot={getLineAnnotationName(writingAnnotation()!)}>
          <Composer
            comment={comment()}
            initial={editing()?.text}
            onCancel={() => props.onWrite(undefined)}
            onSubmit={submit}
            submit={editing() ? 'Save' : 'Add to review'}
          />
        </div>
      </Show>
    </Dynamic>
  )
}
