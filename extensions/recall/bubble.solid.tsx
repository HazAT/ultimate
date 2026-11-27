import type { EntryRecord } from '@earendil-works/pi-durable'
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { cn, useDoc, useTranscript } from '@/sdk/solid'
import { deadline } from '../../lib/timers.shared.ts'
import type { Cancel } from '../../lib/timers.shared.ts'
import { MemoryChip } from '../lineage/ui.solid.tsx'
import { RecallDoc } from './refs.ts'
import { RecalledEntry } from './types.shared.ts'
import type { Recalled } from './types.shared.ts'

function Chips(props: { recalled: Recalled; animate: boolean }) {
  let row!: HTMLDivElement
  createEffect(
    () => props.animate,
    (animate) => {
      if (!animate) return
      row.querySelectorAll('button').forEach((chip, index) =>
        chip.animate(
          [
            { opacity: 0, transform: 'translateY(-8px) scale(0.9)' },
            { opacity: 1, transform: 'none' },
          ],
          {
            duration: 450,
            delay: index * 80,
            easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
            fill: 'backwards',
          },
        ),
      )
    },
  )
  return (
    <div
      class="absolute -bottom-2.5 left-3 flex max-w-[calc(100%-1.5rem)] flex-wrap gap-1"
      data-recall={props.recalled.input}
      ref={row}
    >
      <For each={props.recalled.memories} keyed={(memory) => memory.slug}>
        {(memory) => (
          <MemoryChip
            data-recall-memory={memory().slug}
            name={`Open recalled memory ${memory().slug} from message #${props.recalled.input}`}
            slug={memory().slug}
            title={`Recalled from memory: ${memory().line}`}
          />
        )}
      </For>
    </div>
  )
}

export function RecallBubble(props: { entry: EntryRecord }) {
  const state = useDoc(RecallDoc)
  const transcript = useTranscript()
  const pending = createMemo(() => state()?.pending === props.entry.id)
  const recalled = createMemo(
    () =>
      transcript().find((entry) => RecalledEntry.is(entry) && entry.data.input === props.entry.id)
        ?.data as Recalled | undefined,
  )
  const [sweep, setSweep] = createSignal<'idle' | 'running' | 'done'>('idle')
  let cancelSweep: Cancel | undefined
  createEffect(pending, (isPending) => {
    if (!isPending) return
    cancelSweep?.()
    setSweep('running')
    cancelSweep = deadline(1200, () => setSweep('done'))
  })
  onCleanup(() => cancelSweep?.())
  const checking = () => pending() || sweep() === 'running'
  return (
    <>
      <Show when={sweep() !== 'idle'}>
        <span
          aria-hidden="true"
          class={cn(
            'pointer-events-none absolute inset-0 rounded-lg p-px transition-opacity duration-700',
            checking() ? 'animate-[sweep_1.2s_linear_infinite] opacity-100' : 'opacity-0',
          )}
          data-recall-checking={checking() ? 'true' : undefined}
          style={{
            background:
              'linear-gradient(90deg, transparent 30%, var(--color-brand) 50%, transparent 70%) 0 0 / 300% 100%',
            mask: 'linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0)',
          }}
        />
      </Show>
      <Show when={!checking() && recalled()}>
        {(memory) => <Chips animate={sweep() !== 'idle'} recalled={memory()} />}
      </Show>
    </>
  )
}
