import type { ConversationId, EntryId, EntryRecord } from '@earendil-works/pi-durable'
import { createEffect, createSignal, onSettled } from 'solid-js'
import type { Accessor } from 'solid-js'

import { parseEntryId } from '../../../lib/ids.shared.ts'
import { covered, useEvent, useStore } from '../sdk/hooks.ts'
import type { createTranscriptFrame } from '../sdk/hooks.ts'
import { keepAcrossReload, takeFromLastPage } from '../sdk/resume.ts'
import { anchorSelector } from './compact.ts'
import { follow } from './follow.ts'
import type { Follow } from './follow.ts'
import type { createHistory } from './history.solid.tsx'
import { indexTools, toolCallId } from './model.ts'

type Reading = { entryId: number; last?: number; top: number }
type Anchor = {
  entryId: EntryId
  last?: number
  inner?: boolean
  toolCallId?: string
  top: number
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

const rowGap = (content: Element | undefined) =>
  content ? Number.parseFloat(getComputedStyle(content).rowGap) || 0 : 0
const preloadOneViewportBeforeTop = '100% 0px 0px 0px'

export function createScrollKeeper(options: {
  id: ConversationId | undefined
  history: ReturnType<typeof createHistory>
  loading: Accessor<boolean>
  transcript: ReturnType<typeof createTranscriptFrame>
}) {
  const { id, history, transcript } = options
  let scroll!: HTMLDivElement
  let content!: HTMLDivElement
  let pinned!: HTMLDivElement
  let tail!: HTMLDivElement
  let sentinel: HTMLDivElement | undefined
  const [scroller, setScroller] = createSignal<Follow>()
  const [following, setFollowing] = createSignal(true)
  let held: Element | null = null
  let maxPinnedCover = 0
  let releaseTailOnResize: (() => void) | undefined
  const [tailSpace, setTailSpaceSignal] = createSignal(0)
  const setTailSpace = (next: number | ((space: number) => number)) => {
    const space = typeof next === 'function' ? next(tailSpace()) : next
    tail.style.height = space > 0 ? `${space + rowGap(content)}px` : ''
    setTailSpaceSignal(space)
  }
  const restored = useStore((state) => state.restored)
  const hasRows = () => history.entries().length > 0

  onSettled(() => {
    transcript.mount({ scroll, content })
    const controller = follow(scroll, content, () => {
      setFollowing(controller.following())
      transcript.setAtBottom(controller.atBottom())
      scroll.style.overflowAnchor = controller.following() ? 'none' : ''
    })
    scroll.style.overflowAnchor = 'none'
    setScroller(controller)
    if (id !== undefined && !restored() && !covered() && hasRows() && !reducedMotion())
      fadeInRowsNearTheEnd(scroll, content)
    const release =
      id === undefined
        ? undefined
        : keepAcrossReload(`transcript:${id}`, () =>
            controller.following() ? undefined : readingRow(),
          )
    return () => {
      release?.()
      controller.dispose()
    }
  })

  const readingRow = (): Reading | undefined => {
    const viewTop = scroll.getBoundingClientRect().top
    const row = [...content.querySelectorAll(':scope > [data-entry-id]')].find(
      (element) => element.getBoundingClientRect().bottom > viewTop,
    )
    if (!row) return undefined
    return {
      entryId: Number(row.getAttribute('data-entry-id')),
      last: Number(row.getAttribute('data-run-last')) || undefined,
      top: row.getBoundingClientRect().top - viewTop,
    }
  }
  let reading =
    id === undefined ? undefined : (takeFromLastPage(`transcript:${id}`) as Reading | undefined)
  createEffect(
    () => ({ rows: history.entries().length, controller: scroller() }),
    ({ rows, controller }) => {
      if (!reading || !controller || rows === 0) return
      const { entryId, last, top } = reading
      reading = undefined
      const entry = parseEntryId(entryId)
      const row =
        content.querySelector(anchorSelector({ entryId: entry, last })) ??
        content.querySelector(anchorSelector({ entryId: entry }))
      if (!row) return
      controller.stop()
      const viewTop = scroll.getBoundingClientRect().top
      controller.place(scroll.scrollTop + row.getBoundingClientRect().top - viewTop - top)
    },
  )

  const toEnd = (instant = false) => {
    held = null
    setTailSpace(0)
    scroller()?.toBottom(instant)
  }
  useEvent('ultimate:sent', (value) => {
    if ((value as { conversationId?: ConversationId } | undefined)?.conversationId === id)
      toEnd(true)
  })

  createEffect(tailSpace, (space) => {
    if (space === 0) return undefined
    const releaseTail = () => {
      if (held) return
      const bottom = scroll.scrollHeight - scroll.clientHeight
      const removingTailCannotClampReader = scroll.scrollTop <= bottom - space - rowGap(content)
      if (removingTailCannotClampReader || scroll.scrollTop >= bottom - 1) setTailSpace(0)
    }
    releaseTailOnResize = releaseTail
    scroll.addEventListener('scroll', releaseTail)
    releaseTail()
    return () => {
      releaseTailOnResize = undefined
      scroll.removeEventListener('scroll', releaseTail)
    }
  })

  let anchor: Anchor | null = null
  createEffect(history.history, () => {
    if (!anchor) return
    const { toolCallId: callId, top } = anchor
    const entry = content.querySelector(anchorSelector(anchor))
    const tool =
      callId === undefined
        ? undefined
        : entry?.querySelector(`[data-tool-call-id="${CSS.escape(callId)}"]`)
    const element = tool && tool.getBoundingClientRect().height > 0 ? tool : entry
    if (element) scroller()?.place(scroll.scrollTop + element.getBoundingClientRect().top - top)
    anchor = null
  })
  const keepVisibleRowsAbove = (page: readonly EntryRecord[]) => {
    const entries = history.entries()
    const { calls: mergedCalls } = indexTools([...entries, ...page])
    const newestPrependedEntry = Math.max(0, ...page.map((entry) => entry.id))
    const survivors = new Set<number>(
      entries
        .filter(
          (entry) =>
            entry.id > newestPrependedEntry &&
            !(entry.kind === 'pi.tool-result' && mergedCalls.has(toolCallId(entry) ?? '')),
        )
        .map((entry) => entry.id),
    )
    const viewTop = scroll.getBoundingClientRect().top
    const candidates = [...content.querySelectorAll(':scope > [data-entry-id]')]
      .flatMap((row) => {
        const inside = [...row.querySelectorAll('[data-entry-id]')]
        return inside.length ? inside : [row]
      })
      .filter((row) => row.getBoundingClientRect().bottom > viewTop)
    const survivingVisibleRow = candidates.find((row) =>
      survivors.has(Number(row.getAttribute('data-entry-id'))),
    )
    if (survivingVisibleRow) {
      anchor = {
        entryId: parseEntryId(Number(survivingVisibleRow.getAttribute('data-entry-id'))),
        last: Number(survivingVisibleRow.getAttribute('data-run-last')) || undefined,
        inner: !survivingVisibleRow.parentElement?.isSameNode(content),
        top: survivingVisibleRow.getBoundingClientRect().top,
      }
    } else if (candidates[0]) {
      const orphan = entries.find(
        (entry) => entry.id === Number(candidates[0].getAttribute('data-entry-id')),
      )
      const callId = orphan && toolCallId(orphan)
      const assistantReplacingOrphanResult = page.find((entry) => {
        const message = entry.model?.[0]
        return (
          entry.kind === 'pi.assistant' &&
          message?.role === 'assistant' &&
          message.content.some((block) => block.type === 'toolCall' && block.id === callId)
        )
      })
      if (assistantReplacingOrphanResult)
        anchor = {
          entryId: assistantReplacingOrphanResult.id,
          toolCallId: callId,
          top: candidates[0].getBoundingClientRect().top,
        }
    }
    const follower = scroller()
    if (follower && (!follower.following() || follower.left())) follower.stop()
    setTailSpace((space) => Math.max(space, scroll.clientHeight - content.clientHeight))
  }
  const stop = () => scroller()?.stop()
  createEffect(
    () => ({
      ready:
        !options.loading() &&
        !history.pending() &&
        !history.error() &&
        history.cursor() !== undefined,
      rows: history.history(),
      sentinel: hasRows(),
    }),
    ({ ready }) => {
      if (!ready || !sentinel) return undefined
      const observer = new IntersectionObserver(
        ([seen]) => {
          if (seen?.isIntersecting) void history.loadEarlier(keepVisibleRowsAbove)
        },
        { root: scroll, rootMargin: preloadOneViewportBeforeTop },
      )
      observer.observe(sentinel)
      return () => observer.disconnect()
    },
  )

  const hold = () => {
    const element = held
    const follower = scroller()
    if (!element || !follower) return
    if (!element.isConnected || follower.following()) {
      held = null
      return
    }
    maxPinnedCover = Math.max(maxPinnedCover, pinned.offsetHeight)
    const move =
      element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - maxPinnedCover
    const contentBottom =
      content.getBoundingClientRect().bottom - scroll.getBoundingClientRect().top
    const roomBelow = contentBottom - scroll.clientHeight
    if (move > roomBelow) setTailSpace(tailSpace() + move - roomBelow + rowGap(content))
    follower.place(scroll.scrollTop + move)
  }
  onSettled(() => {
    const resize = new ResizeObserver(() => {
      hold()
      releaseTailOnResize?.()
    })
    for (const element of [scroll, content, pinned]) resize.observe(element)
    const release = () => {
      held = null
    }
    const inputs = ['wheel', 'touchstart', 'pointerdown', 'keydown']
    for (const type of inputs) scroll.addEventListener(type, release, { passive: true })
    return () => {
      resize.disconnect()
      for (const type of inputs) scroll.removeEventListener(type, release)
    }
  })

  return {
    refs: {
      scroll: (element: HTMLDivElement) => {
        scroll = element
      },
      content: (element: HTMLDivElement) => {
        content = element
      },
      pinned: (element: HTMLDivElement) => {
        pinned = element
      },
      sentinel: (element: HTMLDivElement) => {
        sentinel = element
      },
      tail: (element: HTMLDivElement) => {
        tail = element
      },
    },
    content: () => content,
    following,
    placed: () => scroller() !== undefined,
    toEnd,
    stop,
    holdInView: (element: Element) => {
      stop()
      held = element
      maxPinnedCover = 0
      hold()
    },
  }
}

function fadeInRowsNearTheEnd(scroll: HTMLElement, content: HTMLElement) {
  const view = scroll.getBoundingClientRect()
  const rowsWithinOneViewportAbove = [...content.children].filter((row) => {
    const box = row.getBoundingClientRect()
    return box.height > 0 && box.bottom > view.top - view.height && box.top < view.bottom
  })
  rowsWithinOneViewportAbove.toReversed().forEach((row, index) =>
    row.animate([{ opacity: 0 }, { opacity: 1 }], {
      delay: index * 14,
      duration: 260,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'backwards',
    }),
  )
}
