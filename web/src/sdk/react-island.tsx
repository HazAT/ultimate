import type { ComponentType, ReactNode } from 'react'
import { useContext, useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { ConversationId } from '@earendil-works/pi-durable'
import {
  AllProvided,
  ExtensionBoundary,
  Provided,
  Rendered as RenderedPoint,
  Slot,
} from '../app/boundary.tsx'
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

export type SolidPart = {
  mount: (
    host: HTMLElement,
    placed: { conversation?: ConversationId; transcript?: TranscriptFrame },
  ) => () => void
}

export function SolidNode({ part }: { part: SolidPart }) {
  const host = useRef<HTMLDivElement>(null)
  const conversation = useContext(ConversationIdContext)
  const transcript = useContext(TranscriptContext)
  useLayoutEffect(
    () => part.mount(host.current!, { conversation, transcript }),
    [part, conversation, transcript],
  )
  return <div className="contents" ref={host} />
}

export function contribution(
  item: Rendered,
  props: object,
  parts: Record<string, SolidPart> = {},
  fallback: ReactNode = parts.core ? <SolidNode part={parts.core} /> : null,
) {
  const Renderer = item.component as ComponentType<object>
  const placed = Object.fromEntries(
    Object.entries(parts).map(([key, part]) => [key, <SolidNode key={key} part={part} />]),
  )
  return (
    <ExtensionBoundary
      extension={item.extension}
      fallback={fallback}
      key={item.extension}
      version={item.version}
    >
      <Renderer {...props} {...placed} />
    </ExtensionBoundary>
  )
}

export function chain(run: readonly Rendered[], props: object, core: SolidPart) {
  return run.reduce<ReactNode>(
    (inner, item) => contribution(item, { ...props, core: inner }, {}, inner),
    <SolidNode part={core} />,
  )
}

export const slot = (name: SlotName) => <Slot name={name} />

export const renderedPoint = <Input extends object>(
  point: Point<Input & { core: ReactNode }, ReactNode>,
  input: Input,
  core: SolidPart,
) => (
  <RenderedPoint input={input} point={point}>
    <SolidNode part={core} />
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

export const allProvided = <Input, Value>(
  point: Point<Input, Value>,
  input: Input,
  report: (values: readonly Value[]) => void,
) => (
  <AllProvided input={input} point={point}>
    {(values) => <Report report={report} value={values} />}
  </AllProvided>
)

function Report<Value>({ value, report }: { value: Value; report: (value: Value) => void }) {
  useLayoutEffect(() => {
    report(value)
  })
  return null
}
