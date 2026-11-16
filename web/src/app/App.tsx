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

function onScreen({ id, title }: { id: string; title: string }) {
  const current = store.getState().ui.surface
  if (current?.id !== id || current.title !== title) store.setUi({ surface: { id, title } })
}

function BareConversationFallback() {
  useEffect(() => onScreen({ id: HOME, title: 'Agent' }), [])
  return (
    <>
      <Header />
      <Conversation />
      <StatusLine />
    </>
  )
}

const embedded = window.top !== window

let lastReportedMissingSurface: string | undefined

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

function Surfaces({ surfaces }: { surfaces: readonly SurfaceItem[] }) {
  const [surface, ...rest] = surfaces
  if (!surface) return <BareConversationFallback />
  return (
    <SurfaceBoundary
      fallback={<Surfaces surfaces={rest} />}
      key={`${surface.extension}:${surface.id}`}
      surface={surface}
    />
  )
}

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

function Shortcuts() {
  useShortcuts()
  return null
}

export function App() {
  const surfaceAndShortcutsReady = useReady().ready
  const records = useExtensions()
  const { surface, pending, missing } = useShownSurface()
  const streamHasSurfaceChoice = useStore(
    (state) => state.shared !== undefined && state.system !== undefined,
  )
  const home = surfaceItems(records).find((item) => item.id === HOME)
  const shown = useStore((state) => state.ui.surface)
  const viewed = useStore((state) => state.view !== undefined)
  useDocumentTitle(shown)
  const [outOfFlowErrorStack, setOutOfFlowErrorStack] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    const surfaceAndConversationRendered = surfaceAndShortcutsReady && !pending && viewed
    if (surfaceAndConversationRendered) rendered()
  }, [surfaceAndShortcutsReady, pending, viewed])

  useEffect(() => {
    if (!streamHasSurfaceChoice || pending || missing === lastReportedMissingSurface) return
    lastReportedMissingSurface = missing
    if (missing)
      store.notify({
        level: 'warning',
        message:
          missing === HOME
            ? 'The Agent surface is not installed, so a bare conversation shows.'
            : `The ${missing} surface is not installed, so Agent shows.`,
      })
  }, [streamHasSurfaceChoice, pending, missing])
  useEffect(() => {
    if (streamHasSurfaceChoice && shown) uiState.set(shellKeys.shownSurface, shown)
  }, [streamHasSurfaceChoice, shown])

  const line = [surface, surface?.id === HOME ? undefined : home].filter(
    (item): item is SurfaceItem => item !== undefined,
  )
  return (
    <TooltipProvider delayDuration={400}>
      <div className="safe-area flex">
        {surfaceAndShortcutsReady && !embedded && (
          <Slot errors={outOfFlowErrorStack} name="shell.rail" />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          {surfaceAndShortcutsReady && !embedded && <TitleBar />}
          {surfaceAndShortcutsReady && !pending && <Surfaces surfaces={line} />}
        </div>
      </div>
      {surfaceAndShortcutsReady && <Shortcuts />}
      <CommandPalette />
      <ExtensionErrors ref={setOutOfFlowErrorStack} />
      <Slot errors={outOfFlowErrorStack} name="overlay" />
    </TooltipProvider>
  )
}
