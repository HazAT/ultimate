import type { ComponentType, ReactNode } from 'react'
import { useContext, useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { ReactBridge, Rendered, SolidPart } from '../sdk/framework.ts'
import { ExtensionBoundary } from './boundary.tsx'
import { ConversationIdContext, TranscriptContext } from './conversation-scope.tsx'
import { TooltipProvider } from './ui/tooltip.tsx'

function SolidNode({ part }: { part: SolidPart }) {
  const host = useRef<HTMLDivElement>(null)
  const conversation = useContext(ConversationIdContext)
  const transcript = useContext(TranscriptContext)
  useLayoutEffect(
    () => part.mount(host.current!, { conversation, transcript }),
    [part, conversation, transcript],
  )
  return <div className="contents" ref={host} />
}

function contribution(
  item: Rendered,
  props: object,
  parts: Record<string, SolidPart>,
  failure: Parameters<ReactBridge['contribution']>[3],
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
      onError={failure.onError}
      variant={failure.variant}
      version={item.version}
    >
      <Renderer {...props} {...placed} />
    </ExtensionBoundary>
  )
}

function Report({
  use,
  input,
  report,
}: {
  use: unknown
  input: unknown
  report: (value: unknown) => void
}) {
  const value = (use as (input: unknown) => unknown)(input)
  useLayoutEffect(() => {
    report(value)
  })
  return null
}

/** The React side of the core's contribution bridge (`web/src/sdk/contribution.solid.tsx`), loaded with the first React facet. */
export const bridge: ReactBridge = {
  root(host, placed) {
    const root = createRoot(host)
    return {
      render: (element) =>
        flushSync(() =>
          root.render(
            <TooltipProvider delayDuration={400}>
              <ConversationIdContext value={placed.conversation}>
                <TranscriptContext value={placed.transcript}>
                  {element as ReactNode}
                </TranscriptContext>
              </ConversationIdContext>
            </TooltipProvider>,
          ),
        ),
      unmount: () => root.unmount(),
    }
  },
  contribution: (item, props, parts, failure) => contribution(item, props, parts, failure),
  chain: (run, props, core) =>
    run.reduce<ReactNode>(
      (inner, item) => contribution(item, { ...props, core: inner }, {}, {}, inner),
      <SolidNode part={core} />,
    ),
  icon(component, className) {
    const Icon = component as ComponentType<{ className?: string }>
    return <Icon className={className} />
  },
  node: (value) => value,
  provision: (item, input, report, fail) => (
    <ExtensionBoundary
      extension={item.extension}
      key={item.extension}
      onFailed={fail}
      variant="inline"
      version={item.version}
    >
      <Report input={input} key={item.version} report={report} use={item.use} />
    </ExtensionBoundary>
  ),
}
