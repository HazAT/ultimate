import { isMarkTint } from '../../lib/marks.shared.ts'
import type { MarkTint } from '../../lib/marks.shared.ts'
import type { AgentMarkStyle } from './refs.ts'

type Marks = Record<string, AgentMarkStyle> | null | undefined

export function agentTitle(name: string, marks: Marks) {
  if (marks === undefined) return { title: '', brand: false }
  const title = marks?.[name]?.title
  return {
    title: title ?? name.charAt(0).toUpperCase() + name.slice(1),
    brand: name === 'ultimate' && !title,
  }
}

const fallbackTint = 'bg-muted text-muted-foreground ring-border'
const tintClasses: Record<MarkTint, string> = {
  violet: 'bg-violet-500/12 text-violet-600 ring-violet-500/25 dark:text-violet-300',
  blue: 'bg-blue-500/12 text-blue-600 ring-blue-500/25 dark:text-blue-300',
  green: 'bg-emerald-500/12 text-emerald-600 ring-emerald-500/25 dark:text-emerald-300',
  amber: 'bg-amber-500/14 text-amber-700 ring-amber-500/30 dark:text-amber-300',
  red: 'bg-red-500/12 text-red-600 ring-red-500/25 dark:text-red-300',
  pink: 'bg-pink-500/12 text-pink-600 ring-pink-500/25 dark:text-pink-300',
  teal: 'bg-teal-500/12 text-teal-700 ring-teal-500/25 dark:text-teal-300',
  grey: fallbackTint,
}
const builtinTiles = {
  lander: {
    tint: 'bg-success/10 text-success ring-success/25',
    icon: 'GitMerge',
    wide: true,
    strokeWidth: 2.25,
  },
  root: {
    tint: 'bg-brand/8 text-brand/90 ring-brand/20',
    icon: 'ScrollText',
    wide: false,
    strokeWidth: 2,
  },
  memory: {
    tint: 'bg-brand/8 text-brand/90 ring-brand/20',
    icon: 'Brain',
    wide: false,
    strokeWidth: 2,
  },
}
const warned = new Set<string>()

function iconOf<Icon>(icons: Readonly<Record<string, Icon>>, name?: string) {
  if (!name) return icons.Bot
  const key = name.replace(/(^|-)([a-z0-9])/g, (_, _dash: string, letter: string) =>
    letter.toUpperCase(),
  )
  if (icons[key]) return icons[key]
  if (!warned.has(name)) {
    warned.add(name)
    console.warn(`Unknown lucide icon "${name}" in an agent definition; showing the default`)
  }
  return icons.Bot
}

type MarkTile<Icon> = {
  tint: string
  initial?: string
  Icon?: Icon
  iconClass?: string
  strokeWidth?: number
}

export function agentMark<Icon>(
  name: string,
  marks: Marks,
  icons: Readonly<Record<string, Icon>>,
): MarkTile<Icon> {
  const style = marks?.[name]
  if (name === 'ultimate') {
    return {
      tint: 'bg-brand/12 text-brand ring-brand/25',
      initial: marks === undefined ? undefined : Array.from(style?.title || 'U')[0],
    }
  }
  if (name === 'lander' || name === 'root' || name === 'memory') {
    const { tint, icon, wide, strokeWidth } = builtinTiles[name]
    return { tint, Icon: icons[icon], iconClass: wide ? 'size-[60%]' : 'size-[58%]', strokeWidth }
  }
  return {
    tint: isMarkTint(style?.tint) ? tintClasses[style.tint] : fallbackTint,
    Icon: iconOf(icons, style?.icon),
    iconClass: 'size-[60%]',
    strokeWidth: 2,
  }
}

export const standingPlaceholder = (name: string | undefined, title: string, busy: boolean) =>
  name && name !== 'ultimate' && title && !busy ? `Message ${title}…` : undefined
