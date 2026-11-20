/** @jsxImportSource @solidjs/web */
/** The sidebar's parts for other extensions' Solid code: a project's colour swatch and its GitHub label. */
import { Lock } from '@lucide/solid'
import { Show } from 'solid-js'
import { cn } from '@/sdk/solid'
import type { GithubRepo } from '../workspaces/refs.ts'
import { githubMarkPath, isHiddenRepo, swatchClass, swatchStyle } from './colour.ts'

export { stemOf } from './colour.ts'

/** Folder `folder`'s colour, shaded apart from its `family` (the other folders shown beside it), as the sidebar draws it. */
export function ProjectSwatch(props: {
  folder: string
  family?: readonly string[]
  class?: string
}) {
  return (
    <span
      aria-hidden="true"
      class={cn(swatchClass, props.class)}
      data-project-swatch={props.folder}
      style={swatchStyle(props.folder, props.family)}
    />
  )
}

/** A GitHub `owner/repo`, with a lock when it is private or internal. */
export function RepoLabel(props: {
  repo: Pick<GithubRepo, 'name' | 'visibility'>
  class?: string
}) {
  return (
    <span class={cn('flex min-w-0 items-center gap-1', props.class)}>
      <svg
        aria-hidden="true"
        class="size-2.5 shrink-0 opacity-70"
        fill="currentColor"
        viewBox="0 0 16 16"
      >
        <path d={githubMarkPath} />
      </svg>
      <span class="truncate">{props.repo.name}</span>
      <Show when={isHiddenRepo(props.repo.visibility)}>
        <Lock aria-label={props.repo.visibility} class="size-2.5 shrink-0 text-muted-foreground" />
      </Show>
    </span>
  )
}
