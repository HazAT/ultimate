/** @jsxImportSource @solidjs/web */
/** Workspaces for Solid code: Info's checkout summary and a landing's links to Review or DiffsHub. */
import { ArrowUpRight } from '@lucide/solid'
import { Show, createMemo } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { ROOT, cn, events, plural, useAction, useExtensions } from '@/sdk/solid'
import { GithubAction } from './refs.ts'

export { Workspaces, useWorkspacesMeta } from './panel.solid.tsx'

const short = (range: string) => range.replace(/\b([0-9a-f]{7})[0-9a-f]{33}\b/g, '$1')

/** The project's GitHub `owner/repo`, null when `origin` is not on GitHub, undefined until known. */
export function useGithubRepo() {
  const repo = useAction(GithubAction, null, { conversation: ROOT })
  return repo.data
}

function External(props: { href: string; range?: string; label?: string; class?: string }) {
  return (
    <Button
      aria-label={`Compare ${short(props.range ?? props.href)} on DiffsHub`}
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
 * `N commits`: with `range` and the review extension, a button that opens Review at it (DiffsHub as a small ↗ beside
 * it when `href` is given); otherwise a DiffsHub link at `href`, or plain text.
 */
export function CommitCount(props: {
  count: number
  href?: string
  range?: string
  class?: string
}) {
  const extensions = useExtensions()
  const label = () => plural(props.count, 'commit')
  const reviewable = createMemo(
    () =>
      props.range !== undefined &&
      extensions().some((record) => record.name === 'review' && record.extension),
  )
  const plain = () => (
    <Show fallback={<span class={cn('shrink-0', props.class)}>{label()}</span>} when={props.href}>
      {(href) => <External class={props.class} href={href()} label={label()} range={props.range} />}
    </Show>
  )
  return (
    <Show fallback={plain()} when={reviewable()}>
      <span class={cn('inline-flex shrink-0 items-center gap-1', props.class)}>
        <Button
          aria-label={`Review ${short(props.range!)}`}
          class="font-[inherit] text-[length:inherit] font-normal hover:text-foreground hover:underline"
          onClick={() => events.emit('review:open', { spec: props.range })}
          size={null}
          title={`Review ${short(props.range!)}`}
          variant={null}
        >
          {label()}
        </Button>
        <Show when={props.href}>{(href) => <External href={href()} range={props.range} />}</Show>
      </span>
    </Show>
  )
}
