import { ListTodo } from '@lucide/solid'
import { Show } from 'solid-js'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool.solid.tsx'
import { useToolDuration, ROOT, useDocOf, type SolidToolProps } from '@/sdk/solid'
import { TodosDoc } from './refs.ts'

const words = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

export function TodoCall(props: SolidToolProps) {
  const duration = useToolDuration(() => props.call)
  const todos = useDocOf(() => ROOT, TodosDoc)
  const action = () => words(props.call.args.action)
  const owner = () => words(props.call.args.owner)
  const todoText = () => {
    if (action() === 'add') return words(props.call.args.text)
    const id = props.call.args.id
    return (
      /^Done \d+: ([^]*)$/.exec(props.call.output)?.[1] ??
      (typeof id === 'number'
        ? (todos()?.items.find((item) => item.id === id)?.text ?? (id ? `#${id}` : ''))
        : '')
    )
  }
  const verb = () =>
    action() === 'add' ? 'Added a to-do' : action() === 'done' ? 'Done' : 'Listed to-dos'
  return (
    <Show
      when={props.call.status !== 'error' && props.call.status !== 'interrupted'}
      fallback={props.core}
    >
      <Tool>
        <ToolHeader
          aria-label={`To-do #${props.call.id}: ${verb()}`}
          icon={ListTodo}
          meta={
            <>
              <Show when={action() === 'add' && owner()}>
                <span class="rounded-full border border-border/70 px-1.5 leading-4">
                  {owner() === 'user' ? 'you' : '@ultimate'}
                </span>
              </Show>
              <Show when={duration()}>
                <span>{duration()}</span>
              </Show>
            </>
          }
          name=""
          state={props.call.status}
          title={
            <>
              <span class={action() === 'list' ? undefined : 'text-foreground'}>{verb()}</span>
              <Show when={action() !== 'list' && todoText()}>
                <span> · {todoText()}</span>
              </Show>
            </>
          }
        />
        <ToolContent>
          <Show when={action() !== 'list'} fallback={<ToolOutput output={props.call.output} />}>
            <Show when={todoText()}>
              {(text) => (
                <ToolSection>
                  <p class="font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/90">
                    {text()}
                  </p>
                </ToolSection>
              )}
            </Show>
          </Show>
        </ToolContent>
      </Tool>
    </Show>
  )
}
