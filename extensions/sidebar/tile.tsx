import { LockIcon } from 'lucide-react'
import type { CSSProperties } from 'react'
import { cn } from '@/sdk'
import type { GithubRepo } from '../workspaces/refs.ts'
import { githubMarkPath, isHiddenRepo, swatchClass, swatchStyle } from './colour.ts'

export function ProjectSwatch({
  folder,
  family,
  className,
}: {
  folder: string
  family?: readonly string[]
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn(swatchClass, className)}
      data-project-swatch={folder}
      style={swatchStyle(folder, family) as CSSProperties}
    />
  )
}

export function GithubMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden className={className} fill="currentColor" viewBox="0 0 16 16">
      <path d={githubMarkPath} />
    </svg>
  )
}

export function RepoLabel({
  repo,
  className,
}: {
  repo: Pick<GithubRepo, 'name' | 'visibility'>
  className?: string
}) {
  const hidden = isHiddenRepo(repo.visibility)
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
