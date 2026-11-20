import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  defineWebExtension,
  formatDuration,
  formatTokens,
  island,
  useModels,
  useTranscript,
} from '@/sdk'
import type { AssistantMessage, EntryRecord } from '@/sdk'
import { promptTokens as prompt } from '../../lib/context-usage.ts'
import { Connection, Context, Cwd, GlobalUsage, Tokens } from './status.solid.tsx'
import { responseAfter, turnOf } from './turns.ts'

function Item({ children, tip }: { children: ReactNode; tip: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex min-w-0 items-center gap-1.5">{children}</span>
      </TooltipTrigger>
      <TooltipContent className="font-mono text-[11px]" side="top">
        {tip}
      </TooltipContent>
    </Tooltip>
  )
}

const dollars = (cost: number) => `$${cost.toFixed(cost < 1 ? 3 : 2)}`

function MessageUsage({ entry }: { entry: EntryRecord }) {
  const entries = useTranscript()
  const models = useModels()
  const stored = entry.model?.[0]
  const input = stored?.role === 'user'
  const message: AssistantMessage | undefined =
    stored?.role === 'assistant' ? stored : input ? responseAfter(entries, entry) : undefined
  if (!message) return null
  const used = prompt(message.usage)
  if (used === 0) return null
  const window = models?.models.find(
    (model) => model.provider === message.provider && model.id === message.model,
  )?.contextWindow
  const context = window
    ? `${((used / window) * 100).toFixed(1)}% ctx`
    : `${formatTokens(used)} ctx`
  const contextTip = `${used.toLocaleString()}${window ? ` of ${window.toLocaleString()}` : ''} tokens`
  if (input) return <Item tip={<>Sent into a context of {contextTip}</>}>{context}</Item>
  const ended = message.stopReason !== 'toolUse'
  const turn = ended ? turnOf(entries, entry) : undefined
  const many = turn && turn.responses > 1 ? turn : undefined
  const end = message.timestamp + (message.durationMs ?? 0)
  const cost = many ? many.cost : message.usage.cost.total
  const parts = [
    ...(ended ? [message.model] : []),
    context,
    ...(many ? [`turn ${formatDuration(end - many.started)}`] : []),
    ...(cost > 0 ? [dollars(cost)] : []),
  ]
  return (
    <Item
      tip={
        <div className="grid grid-cols-[auto_auto] gap-x-3">
          <span>Response</span>
          <span>
            ↑{formatTokens(used)} ↓{formatTokens(message.usage.output)} ·{' '}
            {dollars(message.usage.cost.total)}
            {message.durationMs ? ` · ${formatDuration(message.durationMs)}` : ''}
          </span>
          {many && (
            <>
              <span>Turn</span>
              <span>
                {many.responses} responses · ↑{formatTokens(many.prompt)} ↓
                {formatTokens(many.output)} · {dollars(many.cost)} ·{' '}
                {formatDuration(end - many.started)}
              </span>
            </>
          )}
          <span>Context</span>
          <span>{contextTip}</span>
          <span>Model</span>
          <span>
            {message.provider}/{message.model}
            {(message.thinkingLevel ?? message.providerThinkingLevel) &&
              ` · ${message.thinkingLevel ?? message.providerThinkingLevel}`}
          </span>
        </div>
      }
    >
      <span className="truncate">{parts.join(' · ')}</span>
    </Item>
  )
}

export default defineWebExtension({
  messageDetails: [MessageUsage],
  slots: {
    'composer.status': [island(Cwd), island(Tokens), island(Context)],
    'statusline.left': [island(GlobalUsage)],
    'statusline.right': [{ component: island(Connection), phone: true }],
  },
})
