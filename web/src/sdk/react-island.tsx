import type { ComponentType, ReactNode } from 'react'
import { useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { ConversationId } from '@earendil-works/pi-durable'
import { ExtensionBoundary, Provided, Rendered as RenderedPoint, Slot } from '../app/boundary.tsx'
import { TooltipProvider } from '../components/ui/tooltip.tsx'
import { ConversationIdContext, TranscriptContext } from './conversation-scope.tsx'
import type { Point, SlotName } from './types.ts'
import type { TranscriptFrame } from './transcript-frame.ts'

export type Rendered = { extension: string; version: number; component: unknown }

export function reactRoot(
  host: HTMLElement,
  context: { conversation?: ConversationId; transcript?: TranscriptFrame },
) {
  const root = createRoot(host)
  return {
    render: (element: ReactNode) => {
      flushSync(() =>
        root.render(
          <TooltipProvider delayDuration={400}>
            <ConversationIdContext value={context.conversation}>
              <TranscriptContext value={context.transcript}>{element}</TranscriptContext>
            </ConversationIdContext>
          </TooltipProvider>,
        ),
      )
    },
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

const reactProps = (props: object) =>
  Object.fromEntries(
    Object.entries(props).map(([key, value]) => [
      key,
      value instanceof HTMLElement && value.dataset.solidHost !== undefined ? (
        <SolidNode key={key} node={value} />
      ) : (
        value
      ),
    ]),
  )

export function contribution(item: Rendered, props: object, fallback: ReactNode = null) {
  const Renderer = item.component as ComponentType<object>
  return (
    <ExtensionBoundary
      extension={item.extension}
      fallback={fallback}
      key={item.extension}
      version={item.version}
    >
      <Renderer {...reactProps(props)} />
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

export const provided = <Input, Value>(
  point: Point<Input, Value>,
  input: Input,
  report: (value: Value | undefined) => void,
) => (
  <Provided input={input} point={point}>
    {(value) => <Report report={report} value={value} />}
  </Provided>
)

function Report<Value>({ value, report }: { value: Value; report: (value: Value) => void }) {
  useLayoutEffect(() => {
    report(value)
  })
  return null
}
