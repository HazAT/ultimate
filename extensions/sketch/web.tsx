import { PencilRulerIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Shimmer } from '@/components/ai/shimmer'
import {
  api,
  attention,
  Card,
  defineWebExtension,
  formatTime,
  useDoc,
  useToolDuration,
} from '@/sdk'
import type { ToolCallView } from '@/sdk'
import { Blocks } from './blocks.tsx'
import { SketchFormsDoc, SubmitAction } from './refs.ts'
import type { SketchDetails } from './refs.ts'

/** A `sketch` call as the UI it drew: a card with the spec's blocks, and "as of" the time it was drawn. */
function SketchCall({ call, core }: { call: ToolCallView; core: ReactNode }) {
  const duration = useToolDuration(call)
  const forms = useDoc(SketchFormsDoc)?.forms
  const details = call.details as SketchDetails | undefined
  if (call.status === 'error' || call.status === 'interrupted') return core
  if (!details?.spec)
    return (
      <Card
        className="flex items-center gap-2 px-3 py-2.5 font-mono text-[0.75rem]"
        data-ui="sketch"
      >
        <PencilRulerIcon className="size-3.5 shrink-0 text-brand" />
        <Shimmer className="min-w-0 truncate">
          {`Sketching ${typeof call.args.request === 'string' ? call.args.request : ''}`}
        </Shimmer>
        {duration && <span className="ml-auto shrink-0 text-muted-foreground">{duration}</span>}
      </Card>
    )
  const { spec, at, read } = details
  const state = forms?.[call.id]
  return (
    <Card className="space-y-3 px-3.5 pt-2.5 pb-3.5" data-ui="sketch">
      <header className="flex items-baseline gap-2 font-mono text-[0.6875rem] text-muted-foreground">
        <PencilRulerIcon className="size-3 shrink-0 translate-y-px self-center text-brand" />
        {spec.title && (
          <span className="min-w-0 truncate text-[0.75rem] font-medium text-foreground">
            {spec.title}
          </span>
        )}
        <span
          className="ml-auto shrink-0"
          title={read?.length ? `Read ${read.join(', ')}` : undefined}
        >
          as of {formatTime(at)}
        </span>
      </header>
      <Blocks
        blocks={spec.blocks}
        form={{
          state,
          submit: state
            ? (values) => api.action(SubmitAction, { call: call.id, values })
            : undefined,
        }}
      />
    </Card>
  )
}

// Drawn for the user to see (and maybe fill in): it never folds into a compact transcript's worked steps.
export default defineWebExtension({ tools: { sketch: attention(SketchCall) } })
