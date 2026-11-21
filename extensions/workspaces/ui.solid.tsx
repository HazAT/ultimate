/** @jsxImportSource @solidjs/web */
/** Workspaces for Solid code: Info's checkout summary and a landing's links to Review or DiffsHub. */
import { ArrowUpRight } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { useProvided } from '@/sdk/parts.solid.tsx'
import { ROOT, cn, plural, useAction } from '@/sdk/solid'
import { Review } from './landing-points.ts'
import { GithubAction, RepoAction } from './refs.ts'

export { Review } from './landing-points.ts'
export { Open } from './landing.solid.tsx'
export { Workspaces, useWorkspacesMeta } from './panel.solid.tsx'

const short = (range: string) => range.replace(/\b([0-9a-f]{7})[0-9a-f]{33}\b/g, '$1')

/** The project's GitHub `owner/repo`, null when `origin` is not on GitHub, undefined until known. */
export function useGithubRepo() {
  const repo = useAction(GithubAction, null, { conversation: ROOT })
  return repo.data
}

/** The project's GitHub repository and its visibility, null when `origin` is not on GitHub. */
export function useProjectRepo() {
  return useAction(RepoAction, null, { conversation: ROOT }).data
}

function External(props: {
  href: string
  range?: string
  label?: string
  class?: string
  card?: number
  name?: string
}) {
  return (
    <Button
      aria-label={
        props.name
          ? `Compare on DiffsHub: ${props.name}`
          : `Compare ${props.card === undefined ? '' : `landing #${props.card}: `}${short(props.range ?? props.href)} on DiffsHub`
      }
      class={cn(
        'h-auto shrink-0 gap-0.5 p-0 font-[inherit] text-[length:inherit] font-normal hover:text-foreground hover:underline',
        props.class,
      )}
      render={(link) => (
        <a {...link} href={props.href} rel="noreferrer" target="_blank">
          {props.label}
          <ArrowUpRight class="size-2.5 opacity-60" />
        </a>
      )}
      size={null}
      title={`Compare on DiffsHub: ${props.href.replace(/^https:\/\/diffshub\.com\//, '')}`}
      variant={null}
    />
  )
}

/**
 * `N commits`: with `range` and a Review provider, a button that opens Review at it (DiffsHub as a small ↗ beside
 * it when `href` is given); otherwise a DiffsHub link at `href`, or plain text. `card` names the landing it belongs to;
 * `name` (`sidebar landing #N`) names the controls instead where the same landing shows twice on a page (the sidebar's
 * Landed list beside History).
 */
export function CommitCount(props: {
  count: number
  card?: number
  name?: string
  href?: string
  range?: string
  class?: string
}) {
  const label = () => plural(props.count, 'commit')
  const plain = () => (
    <Show fallback={<span class={cn('shrink-0', props.class)}>{label()}</span>} when={props.href}>
      {(href) => (
        <External
          card={props.card}
          class={props.class}
          name={props.name}
          href={href()}
          label={label()}
          range={props.range}
        />
      )}
    </Show>
  )
  return (
    <Show fallback={plain()} when={props.range}>
      {(range) => (
        <ReviewCommitCount
          card={props.card}
          class={props.class}
          name={props.name}
          fallback={plain()}
          href={props.href}
          label={label()}
          range={range()}
        />
      )}
    </Show>
  )
}

function ReviewCommitCount(props: {
  range: string
  label: string
  fallback: JSX.Element
  card?: number
  name?: string
  href?: string
  class?: string
}) {
  const open = useProvided(Review, () => props.range)
  return (
    <Show fallback={props.fallback} when={open()}>
      <span class={cn('inline-flex shrink-0 items-center gap-1', props.class)}>
        <Button
          aria-label={
            (props.name && `Review ${props.name}`) ??
            `Review ${props.card === undefined ? '' : `landing #${props.card}: `}${short(props.range)}`
          }
          class="font-[inherit] text-[length:inherit] font-normal hover:text-foreground hover:underline"
          onClick={() => open()?.()}
          size={null}
          title={`Review ${short(props.range)}`}
          variant={null}
        >
          {props.label}
        </Button>
        <Show when={props.href}>
          {(href) => (
            <External card={props.card} href={href()} name={props.name} range={props.range} />
          )}
        </Show>
      </span>
    </Show>
  )
}
