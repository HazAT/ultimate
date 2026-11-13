import { LockIcon } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { cn, prettyName } from '@/sdk'
import type { GithubRepo } from '../workspaces/refs.ts'

/** A hue for a folder name, the same on every instance and page: its characters hashed onto the colour wheel. */
function hueOf(folder: string) {
  let hash = 0
  for (const char of folder.toLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) >>> 0
  return hash % 360
}

/** Up to two letters for a folder name: the initials of its first two words, else its first letter. */
function monogram(folder: string) {
  const words = prettyName(folder).split(' ')
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0]?.[0] ?? '?')).toUpperCase()
}

/**
 * A project's tile: its monogram on a tint of its own hue, so each project reads apart at a glance. The sidebar's
 * header and the project rail draw the same one from the project's folder name.
 */
export function ProjectTile({
  folder,
  size = 'md',
  dim,
  className,
  children,
}: {
  /** The project's folder name: `omarchy-config`. */
  folder: string
  size?: 'md' | 'lg'
  /** Quieter, for projects that are not the one shown; full on hover of a `group`. */
  dim?: boolean
  className?: string
  /** Badges pinned to its corners. */
  children?: ReactNode
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center font-sans font-semibold tracking-tight ring-1 transition-[opacity,filter] ring-inset',
        'bg-[oklch(0.66_0.12_var(--hue)/0.16)] text-[oklch(0.48_0.13_var(--hue))] ring-[oklch(0.62_0.12_var(--hue)/0.32)] dark:text-[oklch(0.82_0.1_var(--hue))]',
        size === 'lg' ? 'size-8 rounded-lg text-[12.5px]' : 'size-7 rounded-[7px] text-[11px]',
        dim && 'opacity-60 saturate-50 group-hover:opacity-100 group-hover:saturate-100',
        className,
      )}
      data-project-tile={folder}
      style={{ '--hue': hueOf(folder) } as CSSProperties}
    >
      {monogram(folder)}
      {children}
    </span>
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
