import { children, createMemo, Match, Switch } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import type { LinkRenderer } from '@/sdk/solid'
import { cn, useExternal, useSystem } from '@/sdk/solid'
import { at, label } from './links.ts'
import { canFrameLoopbackPreviews, getPreviews, isLoopback, show, subscribe } from './previews.ts'
import type { Preview } from './refs.ts'

type Target =
  | { kind: 'self' | 'tailnet'; href: string; open?: undefined }
  | { kind: 'frame'; href: string; open: (event: Pick<MouseEvent, 'preventDefault'>) => void }
  | { kind: 'off'; reason: string; href?: undefined; open?: undefined }

export function previewTarget(
  href: string,
  previews: readonly Preview[] | undefined,
  systemUrl: string | undefined,
  isPreviewOwnUrl = false,
): Target | undefined {
  const url = URL.parse(href)
  if (!url || !/^https?:$/.test(url.protocol) || !isLoopback(url.hostname) || !url.port)
    return undefined
  if (systemUrl && url.port === new URL(systemUrl).port)
    return { kind: 'self', href: at(location.origin, url) }
  const known = previews?.filter((item) => new URL(item.url).port === url.port) ?? []
  const live = known.find((item) => item.running)
  if (!live)
    return known.length || isPreviewOwnUrl ? { kind: 'off', reason: 'Not running' } : undefined
  if (!canFrameLoopbackPreviews)
    return live.tailnet
      ? { kind: 'tailnet', href: at(live.tailnet, url) }
      : { kind: 'off', reason: 'Only on this machine' }
  const frame = at(live.url, url)
  return {
    kind: 'frame',
    href: frame,
    open: (event) => {
      event.preventDefault()
      show(live, frame)
    },
  }
}

export function usePreviewTarget(href: () => string, isPreviewOwnUrl = false) {
  const previews = useExternal(getPreviews, subscribe)
  const system = useSystem()
  return createMemo(() => previewTarget(href(), previews(), system()?.process.url, isPreviewOwnUrl))
}

const chipClass =
  'inline-flex max-w-full items-center gap-1.5 rounded-sm bg-muted/60 px-1.5 align-baseline font-mono text-[11.5px] leading-5 wrap-anywhere'

export const PreviewLink: LinkRenderer = (props) => {
  const target = usePreviewTarget(() => props.href)
  const content = children(() => props.children)
  const offlineReason = () => {
    const link = target()
    return link?.kind === 'off' ? link.reason : undefined
  }
  const text = () => {
    const link = target()
    const parts = content.toArray()
    return link?.kind === 'tailnet' && parts.length === 1 && typeof parts[0] === 'string'
      ? label(parts[0], props.href, link.href)
      : content()
  }
  const open = (event: MouseEvent) => {
    const link = target()
    if (link?.kind === 'frame') link.open(event)
    if (link?.kind === 'tailnet') window.open(link.href, '_blank', 'noreferrer')
  }
  return (
    <Switch fallback={props.core}>
      <Match when={target()?.kind === 'self'}>
        <a href={target()?.href}>{content()}</a>
      </Match>
      <Match when={offlineReason()}>
        <span
          class={cn(chipClass, 'text-muted-foreground')}
          data-preview-link="off"
          title={offlineReason()}
        >
          <span class="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
          {content()}
        </span>
      </Match>
      <Match when={target()}>
        <Button
          class={cn(
            chipClass,
            'h-auto justify-start font-normal whitespace-normal text-left text-foreground transition-colors hover:bg-accent',
          )}
          data-preview-link={target()?.kind}
          onClick={open}
          size={null}
          title={target()?.kind === 'tailnet' ? `Open ${target()?.href}` : 'Show preview'}
          variant={null}
        >
          <span class="size-1.5 shrink-0 rounded-full bg-brand" />
          {text()}
        </Button>
      </Match>
    </Switch>
  )
}
