import { FileTextIcon } from '@lucide/solid'
import { createContext, createEffect, onSettled, Show, useContext } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  events,
  showSurface,
  useEvent,
  useExtensionUiState,
  useExternal,
  useStore,
  writingAs,
} from '@/sdk/solid'
import type { InlineCodeRenderer, LinkRenderer } from '@/sdk/solid'
import { cell } from '../../lib/cell.ts'
import { hrefTarget, isLocalHref, markdownTarget } from './blocks.ts'
import type { Target } from './blocks.ts'

export const InReadFile = createContext(false)

const fromAddress = (): Target | undefined => {
  const params = new URL(location.href).searchParams
  const path = params.get('read')
  if (!path) return undefined
  const line = Number(params.get('line'))
  return { path, ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}) }
}

const tabPath = cell<string | undefined>(fromAddress()?.path)
const lineTarget = cell<{ line: number } | undefined>(undefined, { notifyOnEqual: true })

export function usePath() {
  const [shared, setShared] = useExtensionUiState<string>('path', '')
  const mine = useExternal(tabPath.get, tabPath.subscribe)
  createEffect(
    () => ({ mine: mine(), shared: shared() }),
    (next) => {
      if (next.mine === undefined && next.shared) tabPath.set(next.shared)
    },
  )
  const set = (next: string) => {
    tabPath.set(next)
    setShared(next)
  }
  return [() => mine() ?? '', set] as const
}

export const useLineTarget = () => useExternal(lineTarget.get, lineTarget.subscribe)

export const reachedLine = () => lineTarget.set(undefined)

export const openReader = (target: Target) => events.emit('reader:open', target)

export function ReaderLink() {
  const [path, setPath] = usePath()
  const shownSurface = useStore((state) => state.ui.surface?.id)
  const open = (target: Target) => {
    lineTarget.set(target.line ? { line: target.line } : undefined)
    setPath(target.path)
    showSurface('reader')
  }
  useEvent('reader:open', (target) => open(target as Target))

  const initial = fromAddress()
  let openingFromAddress = initial !== undefined
  onSettled(() => {
    if (initial) writingAs('app', () => open(initial))
  })
  createEffect(
    () => ({ surface: shownSurface(), path: path() }),
    ({ surface, path: shownPath }) => {
      if (!surface || (openingFromAddress && surface !== 'reader')) return
      openingFromAddress = false
      const url = new URL(location.href)
      const shown = surface === 'reader' && shownPath ? shownPath : null
      if (url.searchParams.get('read') === shown) return
      if (shown === null) url.searchParams.delete('read')
      else url.searchParams.set('read', shown)
      url.searchParams.delete('line')
      history.replaceState(history.state, '', url)
    },
  )
  return null
}

const where = (target: Target) => `${target.path}${target.line ? ` at line ${target.line}` : ''}`

export const PathCode: InlineCodeRenderer = (props) => (
  <Show when={markdownTarget(props.code)} fallback={props.core}>
    {(target) => (
      <Button
        aria-label={`Read ${where(target())}`}
        class="inline h-auto font-normal whitespace-normal [&_code]:underline [&_code]:decoration-brand/30 [&_code]:underline-offset-2 hover:[&_code]:decoration-brand"
        data-reader-open={target().path}
        onClick={() => openReader(target())}
        size={null}
        title={`Read ${where(target())}`}
        variant={null}
      >
        {props.core}
      </Button>
    )}
  </Show>
)

export const PathLink: LinkRenderer = (props) => {
  const inReadFile = useContext(InReadFile)
  const target = () => hrefTarget(props.href)
  const localElsewhere = () => inReadFile && isLocalHref(props.href) && props.href.startsWith('/')
  return (
    <Show
      when={target()}
      fallback={
        <Show when={localElsewhere()} fallback={props.core}>
          <span
            class="underline decoration-muted-foreground/50 decoration-dotted underline-offset-2"
            title={props.href}
          >
            {props.children}
          </span>
        </Show>
      }
    >
      {(found) => (
        <a
          data-reader-open={found().path}
          href={`?read=${encodeURIComponent(found().path)}${found().line ? `&line=${found().line}` : ''}`}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey) return
            event.preventDefault()
            openReader(found())
          }}
          title={`Read ${where(found())}`}
        >
          {props.children}
          <FileTextIcon
            aria-hidden="true"
            class="ml-0.5 inline size-3 -translate-y-px opacity-60"
          />
        </a>
      )}
    </Show>
  )
}
