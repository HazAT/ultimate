/** @jsxImportSource @solidjs/web */
import { Bot, Brain, GitMerge, ScrollText } from '@lucide/solid'
import { dynamic } from '@solidjs/web'
import { createMemo, Loading, Show } from 'solid-js'
import { cn, ROOT, useDocOf } from '@/sdk/solid'
import type { MarkTint } from '../../lib/marks.ts'
import { MarksDoc } from '../conversations/refs.ts'

const defaultTint = 'bg-muted text-muted-foreground ring-border'
const tints: Record<MarkTint, string> = {
  violet: 'bg-violet-500/12 text-violet-600 ring-violet-500/25 dark:text-violet-300',
  blue: 'bg-blue-500/12 text-blue-600 ring-blue-500/25 dark:text-blue-300',
  green: 'bg-emerald-500/12 text-emerald-600 ring-emerald-500/25 dark:text-emerald-300',
  amber: 'bg-amber-500/14 text-amber-700 ring-amber-500/30 dark:text-amber-300',
  red: 'bg-red-500/12 text-red-600 ring-red-500/25 dark:text-red-300',
  pink: 'bg-pink-500/12 text-pink-600 ring-pink-500/25 dark:text-pink-300',
  teal: 'bg-teal-500/12 text-teal-700 ring-teal-500/25 dark:text-teal-300',
  grey: defaultTint,
}
const builtins = new Map([
  ['ultimate', { tint: 'bg-brand/12 text-brand ring-brand/25' }],
  ['lander', { tint: 'bg-success/10 text-success ring-success/25', icon: GitMerge, stroke: 2.25 }],
  [
    'root',
    { tint: 'bg-brand/8 text-brand/90 ring-brand/20', icon: ScrollText, size: 'size-[58%]' },
  ],
  ['memory', { tint: 'bg-brand/8 text-brand/90 ring-brand/20', icon: Brain, size: 'size-[58%]' }],
])

export function AgentMark(props: { name: string }) {
  const marks = useDocOf(() => ROOT, MarksDoc)
  const style = () => marks()?.[props.name]
  const builtin = () => builtins.get(props.name)
  const title = () => style()?.title || 'U'
  const iconName = createMemo(() => (builtin() ? undefined : style()?.icon))
  const Icon = dynamic(() => {
    const icon = iconName()
    if (!icon) return builtin()?.icon ?? Bot
    return import('@lucide/solid/icons').then(({ icons }) => {
      const key = icon.replace(/(^|-)([a-z0-9])/g, (_, _dash: string, letter: string) =>
        letter.toUpperCase(),
      )
      return icons[key as keyof typeof icons] ?? Bot
    })
  })
  return (
    <span
      aria-hidden="true"
      class={cn(
        'relative inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] text-[9.5px] ring-1 ring-inset',
        builtin()?.tint ?? tints[style()?.tint as MarkTint] ?? defaultTint,
      )}
      data-agent-mark={props.name}
    >
      <Show
        when={props.name === 'ultimate'}
        fallback={
          <Loading fallback={<Bot class="size-[60%]" strokeWidth={2} />}>
            <Icon class={builtin()?.size ?? 'size-[60%]'} strokeWidth={builtin()?.stroke ?? 2} />
          </Loading>
        }
      >
        <Show when={marks() !== undefined}>
          <span class="font-sans leading-none font-semibold">{Array.from(title())[0]}</span>
        </Show>
      </Show>
    </span>
  )
}
