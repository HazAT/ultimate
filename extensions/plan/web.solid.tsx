import type { ConversationId } from '@earendil-works/pi-durable'
import { ClipboardList, X } from '@lucide/solid'
import { Show, createEffect, createMemo, createSignal, onSettled } from 'solid-js'
import type { Accessor } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  cn,
  defineWebExtension,
  provide,
  useConversationId,
  useDoc,
  useDocOf,
  useSurface,
  useUiState,
  writingAs,
} from '@/sdk/solid'
import { parseConversationId } from '../../lib/ids.shared.ts'
import {
  ConversationEpic,
  ConversationTask,
  ConversationTaskChip,
} from '../conversations/ui.solid.tsx'
import { LandedNote } from '../workspaces/ui.solid.tsx'
import { CriteriaCount, PlanBody, useEstimates } from './body.solid.tsx'
import type { DeepLinkFocus } from './body.solid.tsx'
import { PlanCall } from './call.solid.tsx'
import { criteriaCounts, currentEpic, pillOf, progressLabel } from './progress.shared.ts'
import { PlanDoc, ProgressDoc } from './refs.ts'
import type { Epic, Plan, TaskLink } from './refs.ts'
import { PLAN_OPEN } from './status.web.ts'
import type { PlanOpen } from './status.web.ts'
import { ConversationTaskChip as TaskChipOf } from './task-chip.solid.tsx'
import { TaskChip, useOpenTask, useTaskOf } from './ui.solid.tsx'

const pill =
  'pointer-events-auto flex h-7 max-w-(--plan-pill) min-w-0 items-center gap-1.5 rounded-full border border-border/70 bg-card/90 px-2.5 font-mono text-[11px] text-muted-foreground shadow-sm backdrop-blur hover:text-foreground'

function Panel(props: {
  plan: Plan | null | undefined
  coordinator: ConversationId
  focus: DeepLinkFocus
  own?: string
  close: () => void
}) {
  return (
    <div
      class="pointer-events-auto flex max-h-[60vh] w-[420px] max-w-full flex-col overflow-hidden rounded-lg border border-border/80 bg-popover shadow-lg"
      data-plan-panel
    >
      <div class="flex h-8 shrink-0 items-center gap-1.5 border-b border-border/70 px-3 font-mono text-[11px] text-muted-foreground">
        <ClipboardList class="size-3.5" />
        Plan
        <span class="text-muted-foreground/70">· #{props.coordinator}</span>
        <Button
          aria-label={`Close the plan for #${props.coordinator}`}
          class="ml-auto text-muted-foreground/70 hover:text-foreground"
          onClick={() => props.close()}
          size={null}
          variant={null}
        >
          <X class="size-3.5" />
        </Button>
      </div>
      <div class="min-h-0 overflow-y-auto pb-1">
        <Show
          when={props.plan}
          fallback={
            <p class="px-3 py-2 font-sans text-[12px] text-muted-foreground/70">Loading…</p>
          }
        >
          {(plan) => (
            <PlanBody
              coordinator={props.coordinator}
              focus={props.focus}
              own={props.own}
              plan={plan()}
            />
          )}
        </Show>
      </div>
    </div>
  )
}

type Anchor =
  | { left: number; width: number; pill: number; bottom: number }
  | { right: number; bottom: number }

const overlayStyle = (anchor: Anchor) =>
  'left' in anchor
    ? {
        left: `${anchor.left}px`,
        bottom: `${anchor.bottom}px`,
        'max-width': `${anchor.width}px`,
        '--plan-pill': `${anchor.pill}px`,
      }
    : {
        right: `${anchor.right}px`,
        bottom: `${anchor.bottom}px`,
        'max-width': 'calc(100vw - 1.5rem)',
        '--plan-pill': '100%',
      }

function useAnchor(conversationId: Accessor<ConversationId | undefined>) {
  const [anchor, setAnchor] = createSignal<Anchor>()
  createEffect(conversationId, () => {
    let form: HTMLFormElement | null | undefined
    const measure = () => {
      if (!form?.isConnected) return
      const rect = form.getBoundingClientRect()
      const toggle = form
        .closest(':has(> * > [data-ui="side-chat-switch"])')
        ?.querySelector(':scope > * > [data-ui="side-chat-switch"]')
      const end = toggle?.getBoundingClientRect()
      const row = toggle?.parentElement
      if (!row || !end || end.width === 0) {
        setAnchor({ right: innerWidth - rect.right, bottom: innerHeight - rect.top + 6 })
        return
      }
      const left = Math.max(
        rect.left,
        row.getBoundingClientRect().left + parseFloat(getComputedStyle(row).paddingLeft),
      )
      setAnchor({
        left,
        width: end.right - left,
        pill: end.left - 8 - left,
        bottom: innerHeight - rect.top + 6,
      })
    }
    const columnResizeObserver = new ResizeObserver(measure)
    const attach = () => {
      const container = document.querySelector('[data-composer-target="conversation"]')
      form = container?.querySelector('form')
      if (!container?.parentElement || !form) return false
      columnResizeObserver.disconnect()
      columnResizeObserver.observe(container.parentElement)
      columnResizeObserver.observe(form)
      measure()
      return true
    }
    const appeared = new MutationObserver(() => {
      if (!form?.isConnected) attach()
    })
    if (!attach()) setAnchor(undefined)
    appeared.observe(document.body, { childList: true, subtree: true })
    addEventListener('resize', measure)
    return () => {
      appeared.disconnect()
      columnResizeObserver.disconnect()
      removeEventListener('resize', measure)
    }
  })
  return anchor
}

function PlanOverlay() {
  const surface = useSurface()
  const conversationId = useConversationId()
  const task = useTaskOf(conversationId)
  const anchor = useAnchor(conversationId)
  const [request, setRequest] = useUiState<PlanOpen>(PLAN_OPEN, null)
  onSettled(() => {
    const url = new URL(location.href)
    const key = url.searchParams.get('task')
    const conversation = parseConversationId(Number(url.searchParams.get('conversation')))
    if (!key) return
    url.searchParams.delete('task')
    history.replaceState(history.state, '', url)
    if (Number.isSafeInteger(conversation) && conversation > 0)
      writingAs('app', () => setRequest({ conversation, key }))
  })
  return (
    <Show when={surface() === 'agent' && anchor() && conversationId()} keyed>
      {(conversation) => (
        <div
          class={cn(
            'pointer-events-none fixed z-30 flex flex-col gap-1.5',
            'left' in anchor()! ? 'items-start' : 'items-end',
          )}
          style={overlayStyle(anchor()!)}
        >
          <Show
            when={task()}
            fallback={
              <CoordinatorPlan
                conversation={conversation}
                request={request()?.conversation === conversation ? request() : null}
                settle={() => setRequest(null)}
              />
            }
          >
            {(linked) => <WorkerPlan task={linked()} />}
          </Show>
        </div>
      )}
    </Show>
  )
}

function CoordinatorPlan(props: {
  conversation: ConversationId
  request: PlanOpen
  settle: () => void
}) {
  const plan = useDoc(PlanDoc)
  const [expanded, setExpanded] = useUiState('plan.panel', false)
  const [focus, setFocus] = createSignal<DeepLinkFocus>()
  createEffect(
    () => (plan() === undefined ? null : props.request),
    (request) => {
      if (!request) return
      setFocus({ key: request.key })
      writingAs('app', () => {
        setExpanded(true)
        props.settle()
      })
    },
  )
  const shown = createMemo(() => pillOf(plan()?.epics ?? {}))
  return (
    <>
      <Show when={expanded() && plan()}>
        {(ledger) => (
          <Panel
            close={() => {
              setExpanded(false)
              setFocus(undefined)
            }}
            coordinator={props.conversation}
            focus={focus()}
            plan={ledger()}
          />
        )}
      </Show>
      <Show when={shown()}>
        {(progress) => (
          <Button
            aria-expanded={expanded() ? 'true' : 'false'}
            aria-label={`Toggle the coordinator plan for #${props.conversation}`}
            class={cn(pill, 'font-normal')}
            data-plan-pill
            onClick={() => setExpanded(!expanded())}
            size={null}
            title={`${progress().epic.key} · ${progress().epic.title}`}
            variant={null}
          >
            <ClipboardList class="size-3.5 shrink-0" />
            <span class="text-foreground/80">{progress().epic.key}</span>
            <span class="min-w-0 truncate">
              · <PillProgress coordinator={props.conversation} epic={progress().epic} />
            </span>
            <Show when={progress().more > 0}>
              <span class="text-muted-foreground/70">+{progress().more}</span>
            </Show>
          </Button>
        )}
      </Show>
    </>
  )
}

function PillProgress(props: { coordinator: ConversationId; epic: Epic }) {
  const estimates = useEstimates(
    () => props.coordinator,
    () => props.epic.key,
  )
  const counts = createMemo(() => criteriaCounts(props.epic, estimates()))
  return (
    <Show
      when={Object.keys(props.epic.tasks).length === 0 && counts().total > 0}
      fallback={progressLabel(props.epic)}
    >
      <CriteriaCount counts={counts()} />
    </Show>
  )
}

function WorkerPlan(props: { task: TaskLink }) {
  const [expanded, setExpanded] = useUiState('plan.panel', false)
  const plan = useDocOf(() => (expanded() ? props.task.coordinator : undefined), PlanDoc)
  const openTask = useOpenTask()
  const key = createMemo(() => props.task.key)
  const focus = createMemo(() => ({ key: key() }))
  return (
    <>
      <Show when={expanded()}>
        <Panel
          close={() => setExpanded(false)}
          coordinator={props.task.coordinator}
          focus={focus()}
          own={key()}
          plan={plan()}
        />
      </Show>
      <div class={cn(pill, 'pr-1')} data-plan-pill>
        <TaskChip on="worker plan" task={props.task} />
        <Button
          aria-expanded={expanded() ? 'true' : 'false'}
          aria-label={`Toggle the worker plan for ${key()}: ${props.task.title}`}
          class="inline-block max-w-56 min-w-0 shrink truncate font-normal hover:text-foreground"
          onClick={() => setExpanded(!expanded())}
          size={null}
          title={props.task.title}
          variant={null}
        >
          {props.task.title}
        </Button>
        <Button
          aria-label={`Go to coordinator #${props.task.coordinator} at ${key()} from the worker plan`}
          class="shrink-0 rounded-full px-1.5 font-normal hover:bg-accent hover:text-foreground"
          onClick={() => openTask(props.task)}
          size={null}
          title={`Show coordinator #${props.task.coordinator} at ${key()}`}
          variant={null}
        >
          ↑ #{props.task.coordinator}
        </Button>
      </div>
    </>
  )
}

function useConversationTask(id: Accessor<ConversationId | undefined>) {
  const task = useTaskOf(id)
  return () => {
    const linked = task()
    return linked && { title: linked.title }
  }
}

function LandingCriteria(props: { conversation: ConversationId; submission: string }) {
  const progress = useDocOf(() => props.conversation, ProgressDoc)
  const landing = createMemo(() => {
    const epics = progress()?.epics ?? {}
    const match = Object.entries(epics).find(([, epic]) => epic.landed?.[props.submission])
    if (!match) return undefined
    const [key, epic] = match
    return { key, counts: epic.landed![props.submission] }
  })
  return (
    <Show when={landing()}>
      {(landed) => (
        <p class="text-muted-foreground tabular-nums">
          Criteria{' '}
          <span class={landed().counts.confirmed === landed().counts.total ? 'text-success' : ''}>
            {landed().counts.confirmed}/{landed().counts.total} confirmed
          </span>
          {landed().counts.estimated > 0 && ` · ${landed().counts.estimated} estimated`}
          <span class="text-muted-foreground/60"> · {landed().key}</span>
        </p>
      )}
    </Show>
  )
}

function useConversationEpic(id: Accessor<ConversationId>) {
  const plan = useDocOf(id, PlanDoc)
  const progress = useDocOf(id, ProgressDoc)
  const openTask = useOpenTask()
  return createMemo(() => {
    const epic = currentEpic(plan()?.epics ?? {})
    if (!epic || Object.values(epic.tasks).some((task) => task.child !== undefined))
      return undefined
    const counts = criteriaCounts(epic, progress()?.epics[epic.key]?.estimates)
    const coordinator = id()
    const key = epic.key
    return {
      key,
      title: epic.title,
      status: epic.status,
      progress:
        counts.total > 0 && Object.keys(epic.tasks).length === 0
          ? `${counts.confirmed + counts.estimated}/${counts.total}`
          : undefined,
      open: () => openTask({ coordinator, key }),
    }
  })
}

export default defineWebExtension({
  tools: { plan: PlanCall },
  slots: { overlay: PlanOverlay },
  provides: [
    provide(ConversationTask, useConversationTask),
    provide(ConversationTaskChip, TaskChipOf),
    provide(ConversationEpic, useConversationEpic),
    provide(LandedNote, LandingCriteria),
  ],
})
