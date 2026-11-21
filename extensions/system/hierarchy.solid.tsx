/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { cn, useConversations } from '@/sdk/solid'
import {
  Guide,
  TREE_LEVEL_INDENT_PX,
  LaneRow,
  LANE_HEAD_CENTRE_Y_PX,
  standingName,
} from './lanes.solid.tsx'
import type { LaneState } from './lanes.solid.tsx'
import { chain, links, messageLinks, tree } from './layout.ts'
import type { Frame, WindowName } from './layout.ts'
import type { Lane, LaneLink } from './refs.ts'

const KEY = 'ultimate.system.expanded'

function savedExpanded() {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return new Set<number>(Array.isArray(stored) ? stored.filter(Number.isInteger) : [])
  } catch {
    return new Set<number>()
  }
}

type Box = { left: number; width: number; y: Map<number, number> }

const same = (a: Box, b: Box) =>
  a.left === b.left &&
  a.width === b.width &&
  a.y.size === b.y.size &&
  [...a.y].every(([id, at]) => b.y.get(id) === at)

function useFrame(list: () => HTMLUListElement, rows: () => string) {
  const [box, setBox] = createSignal<Box>()
  createEffect(rows, () => {
    const element = list()
    const measure = () => {
      const timeline = element.querySelector<HTMLElement>('[data-timeline]')
      if (!timeline) return
      const origin = element.getBoundingClientRect()
      const area = timeline.getBoundingClientRect()
      const y = new Map<number, number>()
      for (const row of element.querySelectorAll<HTMLElement>(':scope > [data-lane]'))
        y.set(Number(row.dataset.lane), row.offsetTop + LANE_HEAD_CENTRE_Y_PX)
      const next = { left: area.left - origin.left, width: area.width, y }
      setBox((previous) => (previous && same(previous, next) ? previous : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  })
  return box
}

export function LaneTree(props: {
  lanes: Lane[]
  links: LaneLink[]
  states: Map<number, { state: LaneState; label?: string }>
  window: WindowName
  since: number
  now: number
  onFilter: (conversation: ConversationId) => void
}) {
  const [expanded, setExpanded] = createSignal(savedExpanded())
  const toggle = (parent: number) => {
    const next = new Set(expanded())
    if (!next.delete(parent)) next.add(parent)
    localStorage.setItem(KEY, JSON.stringify([...next].slice(-200)))
    setExpanded(next)
  }
  const [hovered, setHovered] = createSignal<ConversationId>()
  const [picked, setPicked] = createSignal<ConversationId>()
  let list!: HTMLUListElement
  const summaries = useConversations()
  const pinned = createMemo(
    () =>
      props.lanes.find(
        (lane) =>
          standingName(
            lane,
            summaries().find((item) => item.id === lane.conversation),
          ) === 'ultimate',
      )?.conversation,
  )
  const rows = createMemo(() => tree(props.lanes, expanded(), pinned()))
  const box = useFrame(
    () => list,
    () =>
      rows()
        .map((row) => (row.kind === 'lane' ? row.lane.conversation : `+${row.parent}`))
        .join(),
  )
  const frame = createMemo((): Frame | undefined => {
    const area = box()
    if (area) return { y: area.y, width: area.width, since: props.since, now: props.now }
    return undefined
  })
  const focus = () => hovered() ?? picked()
  const lit = createMemo(() => {
    const id = focus()
    return id === undefined ? undefined : chain(props.lanes, id)
  })
  const shown = createMemo(() => rows().flatMap((row) => (row.kind === 'lane' ? [row.lane] : [])))
  const spawns = createMemo(() => (frame() ? links(shown(), frame()!) : []))
  const sent = createMemo(() => {
    const id = focus()
    const area = frame()
    return area && id !== undefined
      ? messageLinks(
          props.links.filter((link) => link.from === id || link.to === id),
          area,
        )
      : []
  })
  const on = (from: ConversationId, to: ConversationId) =>
    !lit() || (lit()!.has(from) && lit()!.has(to))
  return (
    <ul class="relative" ref={list}>
      <For
        each={rows()}
        keyed={(row) => (row.kind === 'lane' ? row.lane.conversation : `fold-${row.parent}`)}
      >
        {(item) => {
          const lane = () => {
            const row = item()
            return row.kind === 'lane' ? row : undefined
          }
          const fold = () => {
            const row = item()
            return row.kind === 'fold' ? row : undefined
          }
          return (
            <>
              <Show when={lane()}>
                {(row) => {
                  const id = () => row().lane.conversation
                  const status = () => props.states.get(id())
                  return (
                    <LaneRow
                      dimmed={!!lit() && !lit()!.has(id())}
                      now={props.now}
                      onFilter={() => props.onFilter(id())}
                      onHover={(hover) => setHovered(hover ? id() : undefined)}
                      onPick={(pick) =>
                        setPicked((current) =>
                          pick ? id() : current === id() ? undefined : current,
                        )
                      }
                      row={row()}
                      since={props.since}
                      state={status()?.state ?? 'idle'}
                      waitLabel={status()?.label}
                      window={props.window}
                    />
                  )
                }}
              </Show>
              <Show when={fold()}>
                {(row) => (
                  <li
                    class={cn(
                      'relative border-b border-border/50 transition-opacity last:border-b-0',
                      lit() && !lit()!.has(row().parent) && 'opacity-40',
                    )}
                    style={{ 'padding-left': `${row().depth * TREE_LEVEL_INDENT_PX}px` }}
                  >
                    <Guide centre={16} row={row()} />
                    <Button
                      aria-label={`Finished lanes under #${row().parent}`}
                      size={null}
                      variant={null}
                      class="flex h-8 items-center pl-2 font-mono text-[10.5px] font-normal text-muted-foreground/70 hover:text-foreground"
                      onClick={() => toggle(row().parent)}
                    >
                      +{row().count} finished
                    </Button>
                  </li>
                )}
              </Show>
            </>
          )
        }}
      </For>
      <Show when={box()}>
        {(area) => (
          <svg
            aria-hidden="true"
            class="pointer-events-none absolute top-0 hidden h-full overflow-visible md:block"
            style={{ left: `${area().left}px`, width: `${area().width}px` }}
          >
            <For each={spawns()} keyed={(link) => link.to}>
              {(link) => (
                <g
                  class={cn(
                    'stroke-muted-foreground transition-opacity',
                    on(link().from, link().to)
                      ? link().inferred
                        ? 'opacity-30'
                        : 'opacity-55'
                      : 'opacity-15',
                  )}
                >
                  <path d={link().d} fill="none" stroke-dasharray="1 3" stroke-linecap="round" />
                  <circle
                    class="fill-muted-foreground stroke-none"
                    cx={link().dot[0]}
                    cy={link().dot[1]}
                    r={2}
                  />
                </g>
              )}
            </For>
            <For each={sent()} keyed={false}>
              {(link) => (
                <g class="stroke-brand opacity-45">
                  <path d={link().d} fill="none" stroke-dasharray="1 3" stroke-linecap="round" />
                  <circle
                    class="fill-brand stroke-none"
                    cx={link().dot[0]}
                    cy={link().dot[1]}
                    r={1.5}
                  />
                </g>
              )}
            </For>
          </svg>
        )}
      </Show>
    </ul>
  )
}
