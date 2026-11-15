import { ROOT } from '@/sdk'
import { ListTodoIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Tool, ToolContent, ToolHeader, ToolOutput, ToolSection } from '@/components/ai/tool'
import { useDocOf, useToolDuration } from '@/sdk'
import type { ToolCallView } from '@/sdk'
import { TodosDoc } from './refs.ts'

const words = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

export function TodoCall({ call, core }: { call: ToolCallView; core: ReactNode }) {
  const duration = useToolDuration(call)
  const items = useDocOf(ROOT, TodosDoc)?.items
  if (call.status === 'error' || call.status === 'interrupted') return core
  const action = words(call.args.action)
  const id = typeof call.args.id === 'number' ? call.args.id : undefined
  const owner = words(call.args.owner)
  const resultTextOrLiveTodoText =
    action === 'add'
      ? words(call.args.text)
      : (/^Done \d+: ([^]*)$/.exec(call.output)?.[1] ??
        items?.find((item) => item.id === id)?.text ??
        (id ? `#${id}` : ''))
  const verb = action === 'add' ? 'Added a to-do' : action === 'done' ? 'Done' : 'Listed to-dos'
  return (
    <Tool>
      <ToolHeader
        icon={ListTodoIcon}
        meta={
          <>
            {action === 'add' && owner && (
              <span className="rounded-full border border-border/70 px-1.5 leading-4">
                {owner === 'user' ? 'you' : '@ultimate'}
              </span>
            )}
            {duration && <span>{duration}</span>}
          </>
        }
        name=""
        state={call.status}
        title={
          <>
            <span className={action === 'list' ? undefined : 'text-foreground'}>{verb}</span>
            {action !== 'list' && resultTextOrLiveTodoText && (
              <span> · {resultTextOrLiveTodoText}</span>
            )}
          </>
        }
      />
      <ToolContent>
        {action === 'list' ? (
          <ToolOutput output={call.output} />
        ) : (
          resultTextOrLiveTodoText && (
            <ToolSection>
              <p className="font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/90">
                {resultTextOrLiveTodoText}
              </p>
            </ToolSection>
          )
        )}
      </ToolContent>
    </Tool>
  )
}
