import { LockIcon } from 'lucide-react'
import type { CSSProperties } from 'react'
import { cn } from '@/sdk'
import type { GithubRepo } from '../workspaces/refs.ts'

/**
 * The palette other projects draw from: muted cool hues from sage through teal to blue, one family of colour. Warm hues
 * are left out, so nothing reads as amber (waiting on the user) or red (failed), and so is violet: purple is Ultimate's.
 */
const HUES = [145, 162, 179, 196, 213, 230, 247]
/** Ultimate's own family takes the brand's hue, a little more saturated than the rest. */
const BRAND = { hue: 300, chroma: 0.11 }
const CHROMA = 0.06
/** Shades a project takes next to others of its family: lightness steps, with a nudge of hue. */
const SHADES = [
  { l: 0, h: 0 },
  { l: -0.1, h: 8 },
  { l: 0.09, h: -8 },
  { l: -0.17, h: 14 },
  { l: 0.15, h: -14 },
]

const hash = (text: string) => {
  let value = 0
  for (const char of text) value = (value * 31 + char.codePointAt(0)!) >>> 0
  return value
}

/** The family a name belongs to: its first word, so `ultimate`, `ultimate-eval` and `ultimate-fleet` share one. */
export const stemOf = (name: string) => name.toLowerCase().split(/[-_.\s]+/)[0] ?? ''

/**
 * A colour for a name (a project's folder; a machine's name works too), the same on every page: its family's hue and a
 * neighbouring shade of it, as oklch parts. The `ultimate` family is purple. The stem itself takes the base shade; a
 * sibling (`ultimate-eval`) the next by its place among the `family` given, sorted, so siblings never share one.
 */
export function colourOf(name: string, family: readonly string[] = []) {
  const key = name.toLowerCase()
  const stem = stemOf(key)
  const siblings = [...new Set(family.map((item) => item.toLowerCase()))]
    .filter((item) => item !== stem && stemOf(item) === stem)
    .toSorted()
  const place = siblings.indexOf(key)
  const shade =
    SHADES[
      key === stem
        ? 0
        : 1 + ((place >= 0 ? place : hash(key.slice(stem.length))) % (SHADES.length - 1))
    ]
  const brand = stem === 'ultimate'
  return {
    hue: (brand ? BRAND.hue : HUES[hash(stem) % HUES.length]) + shade.h,
    chroma: brand ? BRAND.chroma : CHROMA,
    /** Added to the theme's base lightness. */
    lightness: shade.l,
  }
}

/**
 * A project's swatch: a slim bar of its colour, no letters. The project rail stacks them into one quiet column; the
 * sidebar's header leads with the same one, so a project looks alike in both.
 */
export function ProjectSwatch({
  folder,
  family,
  className,
}: {
  /** The project's folder name: `omarchy-config`. */
  folder: string
  /** Every project's folder name shown beside it, so siblings of one stem get distinct shades. */
  family?: readonly string[]
  className?: string
}) {
  const { hue, chroma, lightness } = colourOf(folder, family)
  return (
    <span
      aria-hidden
      className={cn(
        'block shrink-0 bg-[oklch(calc(0.74_+_var(--swatch-l))_var(--swatch-c)_var(--swatch-h))] transition-opacity dark:bg-[oklch(calc(0.6_+_var(--swatch-l))_var(--swatch-c)_var(--swatch-h))]',
        className,
      )}
      data-project-swatch={folder}
      style={{ '--swatch-h': hue, '--swatch-c': chroma, '--swatch-l': lightness } as CSSProperties}
    />
  )
}

/** GitHub's mark, which lucide does not draw. */
export function GithubMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden className={className} fill="currentColor" viewBox="0 0 16 16">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

/** A repository's `owner/repo` with GitHub's mark and, when known, a lock for a private one. */
export function RepoLabel({
  repo,
  className,
}: {
  repo: Pick<GithubRepo, 'name' | 'visibility'>
  className?: string
}) {
  const hidden = repo.visibility === 'private' || repo.visibility === 'internal'
  return (
    <span className={cn('flex min-w-0 items-center gap-1', className)}>
      <GithubMark className="size-2.5 shrink-0 opacity-70" />
      <span className="truncate">{repo.name}</span>
      {hidden && (
        <LockIcon
          aria-label={repo.visibility}
          className="size-2.5 shrink-0 text-muted-foreground"
          role="img"
        />
      )}
    </span>
  )
}
