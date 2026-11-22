import type { ConversationId } from '@earendil-works/pi-durable'
import { ArrowDown, ArrowUp } from '@lucide/solid'
import { createEffect, createMemo, createSignal, For, onSettled, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  cn,
  events,
  ROOT,
  useConversationId,
  useDocOf,
  useTranscript,
  useTranscriptElements,
} from '@/sdk/solid'
import { offscreen } from './data.ts'
import type { Place } from './data.ts'
import { questionsOf } from './waiting.ts'
import type { Question } from './waiting.ts'
import { MessagesDoc } from './refs.ts'

export function OffscreenQuestions() {
  const id = useConversationId()
  const log = useDocOf(() => ROOT, MessagesDoc)
  const entries = useTranscript()
  const questions = createMemo(() => {
    const conversation = id()
    const messages = log()?.messages
    return conversation === undefined || !messages
      ? []
      : questionsOf(conversation, messages, entries())
  })
  return (
    <Show when={questions().length ? id() : undefined} keyed>
      {(conversation) => <Pointers conversation={conversation} questions={questions()} />}
    </Show>
  )
}

const markWidthWithGapsPx = 64

function Pointers(props: { conversation: ConversationId; questions: Question[] }) {
  const { scroll, content } = useTranscriptElements()
  let strip!: HTMLDivElement
  const [places, setPlaces] = createSignal<ReadonlyMap<string, Place>>(new Map())
  const [frame, setFrame] = createSignal<{ wide: boolean; bottom: number }>()

  createEffect(
    () => props.questions,
    (questions) => {
      const root = scroll()
      const list = content()
      if (!root || !list) return undefined
      let targets = new Map<Element | undefined, Question[]>()
      const visible = new Map<Element, boolean>()
      const withinExtendedRoot = new Map<Element, boolean>()
      const placeOf = (target: Element): Place | undefined => {
        const shown = visible.get(target)
        const extended = withinExtendedRoot.get(target)
        return shown === undefined || extended === undefined
          ? undefined
          : shown
            ? 'visible'
            : extended
              ? 'below'
              : 'above'
      }
      const publish = () =>
        setPlaces((previous) => {
          const next = new Map<string, Place>()
          for (const [target, matches] of targets) {
            const place = target ? placeOf(target) : 'above'
            for (const { key } of matches) {
              const known = place ?? previous.get(key)
              if (known) next.set(key, known)
            }
          }
          return next
        })
      const observe = (seen: Map<Element, boolean>, rootMargin?: string) =>
        new IntersectionObserver(
          (changes) => {
            for (const { target, isIntersecting } of changes)
              if (targets.has(target)) seen.set(target, isIntersecting)
            publish()
          },
          { root, rootMargin },
        )
      const observers = [observe(visible), observe(withinExtendedRoot, '0px 0px 1000000px 0px')]
      let attached: (Element | undefined)[] | undefined
      const attach = () => {
        let rows: HTMLElement[] | undefined
        const next = questions.map(({ card, entry }, i) => {
          const previous = attached?.[i]
          if (previous?.matches(card) && list.contains(previous)) return previous
          return (
            list.querySelector(card) ??
            (entry === undefined
              ? undefined
              : (rows ??= [
                  ...list.querySelectorAll<HTMLElement>(':scope > [data-entry-id]'),
                ]).findLast((row) => Number(row.dataset.entryId) <= entry))
          )
        })
        if (attached && next.every((target, i) => target === attached![i])) return
        attached = next
        const groups = Map.groupBy(questions, (_, i) => next[i])
        for (const target of targets.keys()) {
          if (!target || groups.has(target)) continue
          for (const observer of observers) observer.unobserve(target)
          visible.delete(target)
          withinExtendedRoot.delete(target)
        }
        for (const target of groups.keys())
          if (target && !targets.has(target))
            for (const observer of observers) observer.observe(target)
        targets = groups
        publish()
      }
      const rows = new MutationObserver(attach)
      rows.observe(list, { childList: true, subtree: true })
      attach()
      return () => {
        rows.disconnect()
        for (const observer of observers) observer.disconnect()
      }
    },
  )

  onSettled(() => {
    const root = scroll()
    if (!root) return undefined
    const measure = () =>
      setFrame({
        wide:
          strip.getBoundingClientRect().left - root.getBoundingClientRect().left >=
          markWidthWithGapsPx,
        bottom: root.clientHeight - strip.offsetTop,
      })
    measure()
    const resize = new ResizeObserver(measure)
    resize.observe(root)
    let pinned = strip.parentElement
    while (pinned && getComputedStyle(pinned).display === 'contents') pinned = pinned.parentElement
    if (pinned) resize.observe(pinned)
    return () => resize.disconnect()
  })

  const pointers = createMemo(() =>
    offscreen(
      props.questions.map((question) => ({
        key: question,
        place: places().get(question.key) ?? 'visible',
      })),
    ),
  )
  const go = ({ message, entry }: Question) => {
    const conversation = props.conversation
    if (message !== undefined) events.emit('messages:open', { conversation, message })
    else events.emit('ultimate:reveal-entry', { conversationId: conversation, entryId: entry })
  }
  return (
    <div class="relative h-0" data-ui="offscreen-questions" ref={strip}>
      <Show when={frame()}>
        {(layout) => (
          <For each={['up', 'down'] as const}>
            {(direction) => (
              <Show when={pointers()[direction]}>
                {(pointer) => (
                  <Mark
                    count={pointer().count}
                    onClick={() => go(pointer().nearest)}
                    up={direction === 'up'}
                    wide={layout().wide}
                    top={direction === 'up' ? 12 : layout().bottom - (layout().wide ? 48 : 80)}
                  />
                )}
              </Show>
            )}
          </For>
        )}
      </Show>
    </div>
  )
}

function Mark(props: {
  count: number
  onClick: () => void
  up: boolean
  wide: boolean
  top: number
}) {
  const label = () =>
    `${props.count === 1 ? 'A question awaits' : `${props.count} questions await`} your reply ${props.up ? 'above' : 'below'}`
  return (
    <Button
      aria-label={label()}
      class={cn(
        'pointer-events-auto absolute h-7 animate-fade-in rounded-full bg-background font-mono text-[11px] font-normal shadow-sm',
        props.wide ? 'right-full mr-3' : 'left-1/2 -translate-x-1/2',
      )}
      onClick={props.onClick}
      size={null}
      style={{ top: `${props.top}px` }}
      title={label()}
      variant={null}
    >
      <span
        class={cn(
          'flex h-full items-center gap-1 rounded-full bg-amber-500/15 text-amber-700 hover:bg-amber-500/25 dark:text-amber-300',
          props.wide && props.count === 1 ? 'w-7 justify-center' : 'px-2.5',
        )}
      >
        <Show when={props.up} fallback={<ArrowDown class="size-3.5" />}>
          <ArrowUp class="size-3.5" />
        </Show>
        {props.wide
          ? props.count > 1 && props.count
          : `${props.count > 1 ? `${props.count} ` : ''}awaiting your reply`}
      </span>
    </Button>
  )
}
