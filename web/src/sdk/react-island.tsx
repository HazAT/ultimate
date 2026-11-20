import type { ComponentType, ReactNode } from 'react'
import { useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { ConversationId } from '@earendil-works/pi-durable'
import { ExtensionBoundary, Rendered as RenderedPoint, Slot } from '../app/boundary.tsx'
import { TooltipProvider } from '../components/ui/tooltip.tsx'
import { ConversationIdContext, TranscriptContext } from './conversation-scope.tsx'
import type { provisionsOf } from './registry.ts'
import type { Point, SlotName } from './types.ts'
import type { TranscriptFrame } from './transcript-frame.ts'

export type Rendered = { extension: string; version: number; component: unknown }

export function reactRoot(
  host: HTMLElement,
  context: { conversation?: ConversationId; transcript?: TranscriptFrame },
) {
  const root = createRoot(host)
  return {
    render: (element: ReactNode) =>
      flushSync(() =>
        root.render(
          <TooltipProvider delayDuration={400}>
            <ConversationIdContext value={context.conversation}>
              <TranscriptContext value={context.transcript}>{element}</TranscriptContext>
            </ConversationIdContext>
          </TooltipProvider>,
        ),
      ),
    unmount: () => root.unmount(),
  }
}

export function SolidNode({ node }: { node: HTMLElement }) {
  const host = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    host.current!.append(node)
    return () => node.remove()
  }, [node])
  return <div className="contents" ref={host} />
}

export function contribution(item: Rendered, props: object, fallback: ReactNode = null) {
  const Renderer = item.component as ComponentType<object>
  return (
    <ExtensionBoundary
      extension={item.extension}
      fallback={fallback}
      key={item.extension}
      version={item.version}
    >
      <Renderer {...props} />
    </ExtensionBoundary>
  )
}

export function chain(run: readonly Rendered[], props: object, core: HTMLElement) {
  return run.reduce<ReactNode>(
    (inner, item) => contribution(item, { ...props, core: inner }, inner),
    <SolidNode node={core} />,
  )
}

export const slot = (name: SlotName) => <Slot name={name} />

export const renderedPoint = <Input extends object>(
  point: Point<Input & { core: ReactNode }, ReactNode>,
  input: Input,
  core: HTMLElement,
) => (
  <RenderedPoint input={input} point={point}>
    <SolidNode node={core} />
  </RenderedPoint>
)

export function provisions(
  current: ReturnType<typeof provisionsOf>,
  input: unknown,
  report: (values: readonly unknown[]) => void,
) {
  const collected: unknown[] = []
  return current.map((provision, index) => (
    <ExtensionBoundary
      extension={provision.extension}
      fallback={null}
      key={`${provision.extension}:${provision.version}`}
      variant="inline"
      version={provision.version}
    >
      <Provide
        input={input}
        report={(value) => {
          if (index in collected && Object.is(collected[index], value)) return
          collected[index] = value
          report([...collected])
        }}
        use={provision.use as (input: unknown) => unknown}
      />
    </ExtensionBoundary>
  ))
}

function Provide({
  use,
  input,
  report,
}: {
  use: (input: unknown) => unknown
  input: unknown
  report: (value: unknown) => void
}) {
  const value = use(input)
  useLayoutEffect(() => report(value))
  return null
}
