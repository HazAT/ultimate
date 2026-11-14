import { FlagIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Tool, ToolContent, ToolHeader, ToolSection } from '@/components/ai/tool'
import { useToolDuration } from '@/sdk'
import type { ToolCallView } from '@/sdk'

const words = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const prose = 'font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/90'

/** What a `goal` call did, in a line: its verb first, then what it was about. */
function headline(args: ToolCallView['args']): [string, string] {
  const n = typeof args.n === 'number' ? args.n : undefined
  const count = Array.isArray(args.criteria) ? args.criteria.length : 0
  switch (args.action) {
    case 'criteria':
      return ['Set criteria', count ? `${count} to meet` : '']
    case 'decide':
      return ['Decided', [words(args.question), words(args.picked)].filter(Boolean).join(' → ')]
    case 'met':
      return [`Criterion ${n ?? ''} met`, '']
    case 'failed':
      return [`Criterion ${n ?? ''} not met yet`, '']
    case 'finish':
      return ['Goal finished', args.outcome === 'blocked' ? 'blocked' : words(args.outcome)]
    case 'pause':
      return ['Waiting on you', words(args.reason)]
    case 'resume':
      return ['Back on the goal', '']
    default:
      return ['Goal', '']
  }
}

/** One `goal` call as the step it records on the hands-off goal; a failed call keeps the generic card. */
export function GoalCall({ call, core }: { call: ToolCallView; core: ReactNode }) {
  const duration = useToolDuration(call)
  if (call.status === 'error' || call.status === 'interrupted') return core
  const [verb, about] = headline(call.args)
  const criteria = Array.isArray(call.args.criteria) ? call.args.criteria.map(words) : []
  const reason = words(call.args.reason)
  const summary = words(call.args.summary)
  const failed = call.args.action === 'failed'
  return (
    <Tool>
      <ToolHeader
        icon={FlagIcon}
        meta={duration}
        name=""
        state={call.status}
        title={
          <>
            <span className="text-foreground">{verb}</span>
            {about && <span> · {about}</span>}
          </>
        }
      />
      <ToolContent>
        {criteria.length > 0 && (
          <ToolSection label="Done means">
            <ol className={`list-decimal space-y-0.5 pl-5 ${prose}`}>
              {criteria.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ol>
          </ToolSection>
        )}
        {reason && call.args.action !== 'pause' && (
          <ToolSection label="Why">
            <p className={prose}>{reason}</p>
          </ToolSection>
        )}
        {(summary || failed || call.args.action === 'pause') && (
          <ToolSection label={summary ? 'Summary' : undefined}>
            <p className={prose}>{summary || reason || call.output}</p>
          </ToolSection>
        )}
      </ToolContent>
    </Tool>
  )
}
