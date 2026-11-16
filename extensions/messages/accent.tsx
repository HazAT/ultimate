export type Accent = { fill: string; edge: string; name: string }

const palette: readonly Accent[] = [
  {
    fill: 'bg-sky-500/5',
    edge: 'border-sky-500/20',
    name: 'text-sky-700 dark:text-sky-300',
  },
  {
    fill: 'bg-emerald-500/5',
    edge: 'border-emerald-500/20',
    name: 'text-emerald-700 dark:text-emerald-300',
  },
  {
    fill: 'bg-teal-500/5',
    edge: 'border-teal-500/20',
    name: 'text-teal-700 dark:text-teal-300',
  },
  {
    fill: 'bg-rose-500/5',
    edge: 'border-rose-500/20',
    name: 'text-rose-700 dark:text-rose-300',
  },
  {
    fill: 'bg-orange-500/5',
    edge: 'border-orange-500/20',
    name: 'text-orange-700 dark:text-orange-300',
  },
  {
    fill: 'bg-lime-500/5',
    edge: 'border-lime-500/20',
    name: 'text-lime-700 dark:text-lime-300',
  },
]
const user: Accent = {
  fill: 'bg-brand/5',
  edge: 'border-brand/20',
  name: 'text-brand',
}

const fixedUltimatePurple: Accent = {
  fill: 'bg-purple-500/[0.07]',
  edge: 'border-purple-500/25',
  name: 'text-purple-700 dark:text-purple-300',
}

const remoteVioletOutsidePalette: Accent = {
  fill: 'bg-violet-500/[0.07]',
  edge: 'border-violet-500/25',
  name: 'text-violet-700 dark:text-violet-300',
}

export function accentIndex(id: number, size: number) {
  let hash = 0
  for (const char of `#${id}`) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) | 0
  return (hash >>> 0) % size
}

export const accentOf = (id: number | 'user' | 'ultimate' | 'remote'): Accent =>
  id === 'user'
    ? user
    : id === 'ultimate'
      ? fixedUltimatePurple
      : id === 'remote'
        ? remoteVioletOutsidePalette
        : palette[accentIndex(id, palette.length)]
