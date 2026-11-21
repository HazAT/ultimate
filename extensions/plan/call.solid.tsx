/** @jsxImportSource @solidjs/web */
import { For, Show, createMemo } from 'solid-js'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import { useToolDuration, useConversationId, useDoc, type SolidToolProps } from '@/sdk/solid'
import { meansNone } from '../../lib/errors.ts'
import { LiteralPlanText, Tag } from './body.solid.tsx'
import { PlanDoc } from './refs.ts'
import { TaskChip, useOpenTask, useTaskOf } from './ui.solid.tsx'

const text = (value: unknown) => (typeof value === 'string' ? value : '')

function PlanKey(props: { id: string; call: string }) {
  const conversationId = useConversationId()
  const plan = useDoc(PlanDoc)
  const linked = useTaskOf(conversationId)
  const coordinator = () => linked()?.coordinator ?? conversationId()
  const openTask = useOpenTask()
  const ownTask = createMemo(() => {
    const id = coordinator()
    if (id === undefined || id !== conversationId()) return undefined
    const epic = plan()?.epics[props.id.split('.')[0]]
    const task = epic?.tasks[props.id]
    return (
      epic &&
      task && {
        coordinator: id,
        epic: epic.key,
        key: task.key,
        title: task.title,
        status: task.status,
      }
    )
  })
  return (
    <Show
      when={coordinator() !== undefined && /^E\d+(\.\d+)?$/.test(props.id)}
      fallback={<span class="text-foreground/80">{props.id}</span>}
    >
      <Show
        when={ownTask()}
        fallback={
          <Button
            aria-label={`Open ${props.id} from plan call ${props.call}`}
            class="font-normal text-foreground/80 underline-offset-2 hover:underline"
            onClick={() => {
              const id = coordinator()
              if (id !== undefined) openTask({ coordinator: id, key: props.id })
            }}
            size={null}
            title={`Open ${props.id} in the plan`}
            variant={null}
          >
            {props.id}
          </Button>
        }
      >
        {(task) => <TaskChip class="align-middle" on={`plan call ${props.call}`} task={task()} />}
      </Show>
    </Show>
  )
}

const bodyFields = [
  ['Plan', 'body'],
  ['Task', 'description'],
  ['Verdict', 'verdict'],
  ['Note', 'text'],
] as const

export function PlanCall(props: SolidToolProps) {
  const call = () => props.call
  const args = () => call().args
  const action = () => text(args().action)
  const duration = useToolDuration(call)
  const result = createMemo(() => {
    if (call().status !== 'done') return undefined
    try {
      return JSON.parse(call().output) as { key?: string; epics?: unknown } | null
    } catch (error) {
      meansNone(error)
      return undefined
    }
  })
  const key = () =>
    text(args().key) ||
    (result()?.epics ? 'ledger' : result()?.key) ||
    (action() === 'add' ? text(args().epic) : '')
  const detail = () => {
    const { child } = args()
    switch (action()) {
      case 'create':
      case 'add':
        return text(args().title)
      case 'note':
        return text(args().text)
      case 'update':
        return [
          args().status !== undefined && `→ ${text(args().status).replace('_', ' ')}`,
          typeof child === 'number' && `child #${child}`,
          ...(['title', 'description', 'body', 'verdict'] as const).filter(
            (field) => args()[field] !== undefined,
          ),
        ]
          .filter(Boolean)
          .join(' · ')
      default:
        return ''
    }
  }
  const deps = () => args().deps as string[] | undefined
  const isLink = () => /^E\d+(\.\d+)?$/.test(key())
  return (
    <Tool defaultOpen={call().status === 'error'}>
      <ToolHeader
        action={isLink() ? <PlanKey call={call().id} id={key()} /> : undefined}
        aria-label={`Show plan call ${call().id}`}
        meta={
          <>
            <Show when={action() === 'add' && text(args().role)}>
              {(role) => <Tag>{role()}</Tag>}
            </Show>
            <Show when={duration()}>{(time) => <span>{time()}</span>}</Show>
          </>
        }
        name="plan"
        state={call().status}
        title={
          <>
            {action() || '…'}{' '}
            {!isLink() && key() && <span class="text-foreground/80">{key()}</span>} {detail()}
          </>
        }
      />
      <ToolContent>
        <For each={bodyFields}>
          {([label, field]) => (
            <Show when={text(args()[field])}>
              {(value) => (
                <ToolSection label={label}>
                  <div class="font-sans text-[13px] text-foreground/90">
                    <LiteralPlanText>{value()}</LiteralPlanText>
                  </div>
                </ToolSection>
              )}
            </Show>
          )}
        </For>
        <Show when={action() === 'add' && deps()?.length}>
          <ToolSection label="Deps">{deps()?.join(', ')}</ToolSection>
        </Show>
        <Show when={action() === 'show' || call().status === 'error'}>
          <ToolOutput isError={call().status === 'error'} output={call().output} />
        </Show>
        <ToolDiagnostics diagnostics={call().diagnostics} />
      </ToolContent>
    </Tool>
  )
}
