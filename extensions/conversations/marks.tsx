import { ROOT } from '@/sdk'
import { BotIcon, BrainIcon, GitMergeIcon, icons, ScrollTextIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn, useDocOf } from '@/sdk'
import type { MarkTint } from '../../lib/marks.ts'
import { MarksDoc } from './refs.ts'
import type { AgentMarkStyle } from './refs.ts'

const builtinAgentTitles: Record<string, string> = {
  ultimate: 'Ultimate',
  lander: 'Lander',
}
const agentTitle = (name: string) =>
  builtinAgentTitles[name] ?? name.charAt(0).toUpperCase() + name.slice(1)

export function useAgentTitle(name: string) {
  const marks = useDocOf(ROOT, MarksDoc)
  const marksPending = marks === undefined
  if (marksPending) return { title: '', brand: false }
  const title = marks?.[name]?.title
  return { title: title ?? agentTitle(name), brand: name === 'ultimate' && !title }
}

export const standingPlaceholder = (name: string | undefined, title: string, busy: boolean) =>
  name && name !== 'ultimate' && title && !busy ? `Message ${title}…` : undefined

export const AgentTitle = ({ name }: { name: string }) => useAgentTitle(name).title

const initialGlyph = (text: string) => (
  <span className="font-sans leading-none font-semibold">{text}</span>
)

const builtinAgentTiles: Record<string, { tint: string; glyph: ReactNode }> = {
  ultimate: {
    tint: 'bg-brand/12 text-brand ring-brand/25',
    glyph: initialGlyph('U'),
  },
  lander: {
    tint: 'bg-success/10 text-success ring-success/25',
    glyph: <GitMergeIcon className="size-[60%]" strokeWidth={2.25} />,
  },
  root: {
    tint: 'bg-brand/8 text-brand/90 ring-brand/20',
    glyph: <ScrollTextIcon className="size-[58%]" strokeWidth={2} />,
  },
  memory: {
    tint: 'bg-brand/8 text-brand/90 ring-brand/20',
    glyph: <BrainIcon className="size-[58%]" strokeWidth={2} />,
  },
}
const fallbackTint = 'bg-muted text-muted-foreground ring-border'
const fallbackGlyph = <BotIcon className="size-[60%]" strokeWidth={2} />

const tailwindTintClasses: Record<MarkTint, string> = {
  violet: 'bg-violet-500/12 text-violet-600 ring-violet-500/25 dark:text-violet-300',
  blue: 'bg-blue-500/12 text-blue-600 ring-blue-500/25 dark:text-blue-300',
  green: 'bg-emerald-500/12 text-emerald-600 ring-emerald-500/25 dark:text-emerald-300',
  amber: 'bg-amber-500/14 text-amber-700 ring-amber-500/30 dark:text-amber-300',
  red: 'bg-red-500/12 text-red-600 ring-red-500/25 dark:text-red-300',
  pink: 'bg-pink-500/12 text-pink-600 ring-pink-500/25 dark:text-pink-300',
  teal: 'bg-teal-500/12 text-teal-700 ring-teal-500/25 dark:text-teal-300',
  grey: fallbackTint,
}

const iconOf = (name: string) =>
  icons[
    name.replace(/(^|-)([a-z0-9])/g, (_, _dash: string, letter: string) =>
      letter.toUpperCase(),
    ) as keyof typeof icons
  ]

const warned = new Set<string>()
function definedTile(style: AgentMarkStyle | undefined) {
  const Icon = style?.icon ? iconOf(style.icon) : undefined
  if (style?.icon && !Icon && !warned.has(style.icon)) {
    warned.add(style.icon)
    console.warn(`Unknown lucide icon "${style.icon}" in an agent definition; showing the default`)
  }
  return {
    tint: (style?.tint && tailwindTintClasses[style.tint as MarkTint]) || fallbackTint,
    glyph: Icon ? <Icon className="size-[60%]" strokeWidth={2} /> : fallbackGlyph,
  }
}

export type Presence = 'working' | 'waiting' | 'idle'

export function AgentMark({
  name,
  size = 'md',
  presence,
}: {
  name: string
  size?: 'xs' | 'sm' | 'md' | 'lg'
  presence?: Presence
}) {
  const marks = useDocOf(ROOT, MarksDoc)
  const style = marks?.[name]
  const tile = builtinAgentTiles[name] ?? definedTile(style)
  const titleInitialAfterMarksArrive =
    name !== 'ultimate'
      ? tile.glyph
      : marks === undefined
        ? null
        : style?.title
          ? initialGlyph(Array.from(style.title)[0])
          : tile.glyph
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-[5px] ring-1 ring-inset',
        tile.tint,
        size === 'lg' && 'size-10 rounded-[8px] text-[18px]',
        size === 'md' && 'size-6 text-[12px]',
        size === 'sm' && 'size-4 rounded-[4px] text-[9.5px]',
        size === 'xs' && 'size-3.5 rounded-[3px] text-[8.5px]',
      )}
      data-agent-mark={name}
    >
      {titleInitialAfterMarksArrive}
      {presence && (
        <span
          className={cn(
            'absolute -right-0.5 -bottom-0.5 rounded-full ring-2 ring-sidebar',
            size === 'md' ? 'size-2' : 'size-1.5 ring-[1.5px]',
            presence === 'working'
              ? 'animate-pulse-dot bg-brand'
              : presence === 'waiting'
                ? 'bg-amber-400'
                : 'bg-muted-foreground/60',
          )}
          data-presence={presence}
        />
      )}
    </span>
  )
}
