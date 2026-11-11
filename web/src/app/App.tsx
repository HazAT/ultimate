import { Component, useEffect, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { shellKeys } from '../sdk/actions.ts'
import { ROOT } from '../sdk/api.ts'
import { store, uiState } from '../sdk/client.ts'
import { errorMessage } from '../sdk/format.ts'
import {
  ExtensionNameContext,
  useConversation,
  useConversationSummary,
  useExtensions,
  useReady,
  useShownSurface,
  useStore,
  useSystem,
} from '../sdk/hooks.ts'
import { HOME, surfaceItems } from '../sdk/registry.ts'
import type { SurfaceItem } from '../sdk/registry.ts'
import { rendered } from '../sdk/resume.ts'
import { ExtensionErrors, Slot } from './boundary.tsx'
import { useShortcuts } from './keyboard.ts'
import { CommandPalette } from './palette.tsx'
import { Conversation, Header, StatusLine } from './primitives.tsx'
import { SurfaceContext } from './surface.ts'
import { TitleBar, projectTitle } from './titlebar.tsx'

/** Records the surface on screen, for the window title, `useUltimate().surface`, and the agent's prompt. */
function onScreen({ id, title }: { id: string; title: string }) {
  const current = store.getState().ui.surface
  if (current?.id !== id || current.title !== title) store.setUi({ surface: { id, title } })
}

/** What shows when not even the Agent surface can, such as after a broken `extensions/agent` reloads. */
function Frame() {
  useEffect(() => onScreen({ id: HOME, title: 'Agent' }), [])
  return (
    <>
      <Header />
      <Conversation />
      <StatusLine />
    </>
  )
}

/** An Ultimate shown inside another one's window, under that one's title bar, shows none of its own. */
const embedded = window.top !== window

/** The missing surface last reported, so it is reported once until it shows again. */
let reported: string | undefined

/**
 * Renders one surface; if it throws, renders `fallback` (the next surface in line) with a notice. A new version of the
 * surface's extension retries it.
 */
class SurfaceBoundary extends Component<
  { surface: SurfaceItem; fallback: ReactNode },
  { failed: boolean; version: number }
> {
  state = { failed: false, version: this.props.surface.version }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  static getDerivedStateFromProps(
    props: { surface: SurfaceItem },
    state: { failed: boolean; version: number },
  ) {
    return props.surface.version === state.version
      ? null
      : { failed: false, version: props.surface.version }
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    const { surface } = this.props
    console.error(`[surface ${surface.id}]`, error, info.componentStack)
    const instead = surface.id === HOME ? 'a bare conversation shows' : 'Agent shows'
    store.notify({
      level: 'warning',
      message: `The ${surface.title} surface (${surface.extension}) failed, so ${instead}: ${errorMessage(error)}`,
    })
  }
  // A failed boundary renders the next in line, which reports itself instead.
  componentDidMount() {
    if (!this.state.failed) onScreen(this.props.surface)
  }
  componentDidUpdate() {
    if (!this.state.failed) onScreen(this.props.surface)
  }
  render() {
    if (this.state.failed) return this.props.fallback
    const { surface } = this.props
    const Surface = surface.component
    return (
      <SurfaceContext.Provider value={surface.id}>
        <ExtensionNameContext.Provider value={surface.extension}>
          <Surface />
        </ExtensionNameContext.Provider>
      </SurfaceContext.Provider>
    )
  }
}

/** The first of `surfaces` that renders; the bare frame when none does. */
function Surfaces({ surfaces }: { surfaces: readonly SurfaceItem[] }) {
  const [surface, ...rest] = surfaces
  if (!surface) return <Frame />
  return (
    <SurfaceBoundary
      fallback={<Surfaces surfaces={rest} />}
      key={`${surface.extension}:${surface.id}`}
      surface={surface}
    />
  )
}

/**
 * The window title: the project's folder first, so tabs of several projects tell apart, then the shown conversation on
 * Agent or the surface elsewhere; a dot while the agent works.
 */
function useDocumentTitle(surface: { id: string; title: string } | undefined) {
  const { id, busy } = useConversation()
  const label = useConversationSummary(id)?.label
  const project = projectTitle(useSystem())
  const app = surface && surface.id !== HOME ? surface.title : undefined
  useEffect(() => {
    const shown = app ?? (id === ROOT || id === undefined ? undefined : (label ?? `#${id}`))
    const name = [project ?? 'Ultimate', shown].filter(Boolean).join(' · ')
    document.title = busy ? `● ${name}` : name
  }, [app, label, busy, id, project])
}

/** Command shortcuts, which start with the app. */
function Shortcuts() {
  useShortcuts()
  return null
}

/**
 * The surface host: the shown surface fills the window; the palette, extension errors, and overlays sit above it.
 * Overlays render as soon as they install, but the app (the surface and its shortcuts) waits until the page is ready,
 * so it never shows half loaded: until then the background `index.html` paints shows beneath them. Starting the
 * shortcuts then also lets an overlay that covers the page, such as the splash, take the keys before they do.
 */
export function App() {
  const loaded = useReady().ready
  const records = useExtensions()
  const { surface, pending, missing } = useShownSurface()
  // Until the stream delivered the UI state and system info, the choice and the project default are unknown.
  const ready = useStore((state) => state.shared !== undefined && state.system !== undefined)
  const home = surfaceItems(records).find((item) => item.id === HOME)
  const shown = useStore((state) => state.ui.surface)
  const viewed = useStore((state) => state.view !== undefined)
  useDocumentTitle(shown)
  // Overlays sit outside the 100dvh shell, the rail outside any sized panel: a failed item shows in the fixed error
  // stack, not below the shell (#565199: a page one card taller than the window) or as a column squeezing the app.
  const [errors, setErrors] = useState<HTMLDivElement | null>(null)
  // The surface and its conversation are on screen: what a reload resumes, and what a resumed reload uncovers.
  useEffect(() => {
    if (loaded && !pending && viewed) rendered()
  }, [loaded, pending, viewed])

  useEffect(() => {
    if (!ready || pending || missing === reported) return
    reported = missing
    if (missing)
      store.notify({
        level: 'warning',
        message:
          missing === HOME
            ? 'The Agent surface is not installed, so a bare conversation shows.'
            : `The ${missing} surface is not installed, so Agent shows.`,
      })
  }, [ready, pending, missing])
  // Record what the user looks at: what rendered, so Agent after the chosen surface failed. Equal writes are dropped.
  useEffect(() => {
    if (ready && shown) uiState.set(shellKeys.shownSurface, shown)
  }, [ready, shown])

  const line = [surface, surface?.id === HOME ? undefined : home].filter(
    (item): item is SurfaceItem => item !== undefined,
  )
  return (
    <TooltipProvider delayDuration={400}>
      <div className="safe-area flex">
        {loaded && !embedded && <Slot errors={errors} name="shell.rail" />}
        <div className="flex min-w-0 flex-1 flex-col">
          {loaded && !embedded && <TitleBar />}
          {loaded && !pending && <Surfaces surfaces={line} />}
        </div>
      </div>
      {loaded && <Shortcuts />}
      <CommandPalette />
      <ExtensionErrors ref={setErrors} />
      <Slot errors={errors} name="overlay" />
    </TooltipProvider>
  )
}
