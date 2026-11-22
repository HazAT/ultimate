/** @jsxImportSource @solidjs/web */
import { createEffect, createMemo, createSignal, For, onSettled, Show } from 'solid-js'
import {
  errorMessage,
  ROOT,
  useConversation,
  useConversations,
  useExtensions,
  useReady,
  useStore,
  useSystem,
  useUiState,
} from '../sdk/hooks.ts'
import type { JsonValue } from '@earendil-works/chord/json'
import { shellKeys, shownSurface } from '../sdk/actions.ts'
import { store, uiState } from '../sdk/client.ts'
import { Contribution, Slot } from '../sdk/contribution.solid.tsx'
import { HOME, surfaceItems } from '../sdk/registry.ts'
import type { SurfaceItem } from '../sdk/registry.ts'
import { rendered } from '../sdk/resume.ts'
import { ExtensionErrors, StackedFailure } from './error-stack.solid.tsx'
import { Header } from './header.solid.tsx'
import { installShortcuts } from './keyboard.ts'
import { CommandPalette } from './palette.solid.tsx'
import { projectTitle } from './project.ts'
import { Conversation, StatusLine } from './shell.solid.tsx'
import { TitleBar } from './titlebar.solid.tsx'

function onScreen({ id, title }: { id: string; title: string }) {
  const current = store.getState().ui.surface
  if (current?.id !== id || current.title !== title) store.setUi({ surface: { id, title } })
}

function BareConversationFallback() {
  onSettled(() => onScreen({ id: HOME, title: 'Agent' }))
  return (
    <>
      <Header />
      <Conversation />
      <StatusLine />
    </>
  )
}

function SurfaceFailed(props: { surface: SurfaceItem; error: unknown; onFailed: () => void }) {
  onSettled(() => {
    const { surface, error } = props
    console.error(`[surface ${surface.id}]`, error)
    const instead = surface.id === HOME ? 'a bare conversation shows' : 'Agent shows'
    store.notify({
      level: 'warning',
      message: `The ${surface.title} surface (${surface.extension}) failed, so ${instead}: ${errorMessage(error)}`,
    })
    props.onFailed()
  })
  return null
}

function Surfaces(props: { surfaces: readonly SurfaceItem[] }) {
  return (
    <Show when={props.surfaces[0]} fallback={<BareConversationFallback />}>
      {(first) => (
        <For
          each={[first()]}
          keyed={(surface) => `${surface.extension}:${surface.id}:${surface.version}`}
        >
          {(surface) => <SurfaceLevel rest={props.surfaces.slice(1)} surface={surface()} />}
        </For>
      )}
    </Show>
  )
}

function SurfaceLevel(props: { surface: SurfaceItem; rest: readonly SurfaceItem[] }) {
  const [failed, setFailed] = createSignal(false)
  createEffect(
    () => (failed() ? undefined : { id: props.surface.id, title: props.surface.title }),
    (shown) => {
      if (shown) onScreen(shown)
    },
  )
  return (
    <Contribution
      fallback={(_, error) => (
        <>
          <SurfaceFailed error={error} onFailed={() => setFailed(true)} surface={props.surface} />
          <Surfaces surfaces={props.rest} />
        </>
      )}
      fallbackOnly
      item={props.surface}
      props={{}}
    />
  )
}

function useDocumentTitle() {
  const conversation = useConversation()
  const conversations = useConversations()
  const system = useSystem()
  const shown = useStore((state) => state.ui.surface)
  createEffect(
    () => {
      const { id, busy } = conversation()
      const label = conversations().find((row) => row.id === id)?.label
      const surface = shown()
      const app = surface && surface.id !== HOME ? surface.title : undefined
      const named = app ?? (id === ROOT || id === undefined ? undefined : (label ?? `#${id}`))
      const name = [projectTitle(system()) ?? 'Ultimate', named].filter(Boolean).join(' · ')
      return busy ? `● ${name}` : name
    },
    (title) => {
      document.title = title
    },
  )
}

const embedded = window.top !== window

let lastReportedMissingSurface: string | undefined

export function App() {
  const readiness = useReady()
  const ready = createMemo(() => readiness().ready)
  const extensions = useExtensions()
  const [chosen] = useUiState<JsonValue>(shellKeys.surface, null)
  const preferred = useStore((state) => state.system?.project.settings.defaultSurface)
  const resolved = createMemo(() => shownSurface(extensions(), chosen(), preferred()))
  const pending = () => resolved().pending
  const streamHasSurfaceChoice = useStore(
    (state) => state.shared !== undefined && state.system !== undefined,
  )
  const shown = useStore((state) => state.ui.surface)
  const viewed = useStore((state) => state.view !== undefined)
  const stack = (<div class="contents" />) as HTMLDivElement
  useDocumentTitle()

  createEffect(
    () => ready() && !pending() && viewed(),
    (surfaceAndConversationRendered) => {
      if (surfaceAndConversationRendered) rendered()
    },
  )
  createEffect(
    () => ({ choice: streamHasSurfaceChoice(), pending: pending(), missing: resolved().missing }),
    ({ choice, pending: waiting, missing }) => {
      if (!choice || waiting || missing === lastReportedMissingSurface) return
      lastReportedMissingSurface = missing
      if (missing)
        store.notify({
          level: 'warning',
          message:
            missing === HOME
              ? 'The Agent surface is not installed, so a bare conversation shows.'
              : `The ${missing} surface is not installed, so Agent shows.`,
        })
    },
  )
  createEffect(
    () => ({ choice: streamHasSurfaceChoice(), surface: shown() }),
    ({ choice, surface }) => {
      if (choice && surface) uiState.set(shellKeys.shownSurface, surface)
    },
  )
  createEffect(ready, (on) => (on ? installShortcuts() : undefined))

  const line = createMemo(
    () => {
      const surface = resolved().surface
      const home = surfaceItems(extensions()).find((item) => item.id === HOME)
      return [surface, surface?.id === HOME ? undefined : home].filter(
        (item): item is SurfaceItem => item !== undefined,
      )
    },
    {
      equals: (a, b) =>
        a.length === b.length &&
        a.every(
          (item, at) =>
            item.extension === b[at].extension &&
            item.id === b[at].id &&
            item.version === b[at].version &&
            item.component === b[at].component,
        ),
    },
  )
  const outOfFlow = (extension: string, error: unknown, trace?: string) => (
    <StackedFailure error={error} extension={extension} stack={stack} trace={trace} />
  )
  return (
    <>
      <div class="safe-area flex">
        <Show when={ready() && !embedded}>
          <Slot fallback={outOfFlow} fallbackOnly name="shell.rail" />
        </Show>
        <div class="flex min-w-0 flex-1 flex-col">
          <Show when={ready() && !embedded}>
            <TitleBar />
          </Show>
          <Show when={ready() && !pending()}>
            <Surfaces surfaces={line()} />
          </Show>
        </div>
      </div>
      <CommandPalette />
      <ExtensionErrors stack={stack} />
      <Slot fallback={outOfFlow} fallbackOnly name="overlay" />
    </>
  )
}
