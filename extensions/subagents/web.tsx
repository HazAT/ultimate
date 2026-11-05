import {
  GitBranchIcon,
  GitMergeIcon,
  NetworkIcon,
  SquareArrowOutUpRightIcon,
  Trash2Icon,
} from 'lucide-react'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { MentionText, Message, MessageResponse } from '@/components/ai/message'
import { Shimmer } from '@/components/ai/shimmer'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool'
import { Button } from '@/components/ui/button'
import {
  api,
  cn,
  defineWebExtension,
  ErrorReport,
  insertIntoComposer,
  provide,
  Provided,
  useConversation,
  useConversationSummary,
  useDocOf,
  useStore,
  useToolDuration,
  useUiState,
  useUltimate,
} from '@/sdk'
import type { ToolCallView } from '@/sdk'
import { ConversationTask } from '../conversations/ui.tsx'
import { stateLabel, useWorkspaces } from '../workspaces/ui.tsx'
import type { Workspace as Isolate, LandResult } from '../workspaces/types.ts'
import { agentsPanel } from '../models/ui.tsx'
import { DefinitionDialog } from './definitions.tsx'
import { AgentsOverview } from './overview.tsx'
import { Tag } from './parts.tsx'
import { AgentInbox, AgentInput, AgentMessages } from './messages.tsx'
import { openAgentSource, RunName, talkToUltimate } from './ui.tsx'
import { StandingAction, StandingDoc } from './refs.ts'
import { landing } from './landing.ts'

const text = (value: unknown) => (typeof value === 'string' ? value : '')

function BusyDot({ className }: { className?: string }) {
  return (
    <span className={cn('size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand', className)} />
  )
}

function StateTag({ isolate }: { isolate: Isolate }) {
  if (isolate.state === 'ready') return null
  return (
    <Tag
      className={cn(
        'font-mono',
        isolate.state === 'failed' ? 'border-error/40 text-error' : 'text-muted-foreground',
      )}
    >
      <span title={isolate.landed ? `Last landed ${isolate.landed.slice(0, 7)}` : undefined}>
        {stateLabel(isolate)}
      </span>
    </Tag>
  )
}

/** The call card's compact workspace: branch and state from the child's summary. */
function IsolateBadge({ childId }: { childId: number }) {
  const isolate = useWorkspaces()[String(childId)]
  if (!isolate) return null
  return (
    <span
      className="flex items-center gap-1 font-mono"
      title={`${isolate.branch}\n${isolate.path}`}
    >
      <GitBranchIcon className="size-3 shrink-0" />
      <StateTag isolate={isolate} />
    </span>
  )
}

/** One `subagent` call: who got which task, how the child is doing, its answer, and a way into it. */
function SubagentCall({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const { switchConversation } = useUltimate()
  const id = useConversation((conversation) => conversation.id)
  const action = text(call.args.action) || 'start'
  const details = call.details as
    | { conversationId?: number; background?: boolean; yielded?: boolean; answerId?: number }
    | undefined
  const childId =
    details?.conversationId ?? (typeof call.args.id === 'number' ? call.args.id : undefined)
  const child = useConversationSummary(childId)
  const agent = child?.label || text(call.args.label) || text(call.args.agent)
  const background = call.args.background === true || details?.background === true
  const instruction = action === 'start' ? text(call.args.task) : text(call.args.text)
  const finished = call.status === 'done' || call.status === 'error'
  const yielded = details?.yielded === true
  const working = child?.busy && (background || yielded || !finished)
  const title: ReactNode =
    action === 'start' ? (
      <>
        <span className="text-brand">
          <RunName id={childId} label={agent || '…'} />
        </span>{' '}
        {instruction}
      </>
    ) : action === 'list' ? (
      'list children'
    ) : (
      <>
        {action} <span className="text-foreground/80">#{childId ?? '?'}</span>
        {call.args.steer === false && ' (follow-up)'} {instruction}
      </>
    )
  return (
    <Tool defaultOpen={!finished || call.status === 'error'}>
      <div className="flex items-center">
        <ToolHeader
          className="min-w-0 flex-1"
          meta={
            <>
              <Provided input={childId} point={ConversationTask}>
                {(task) => task?.chip}
              </Provided>
              {childId !== undefined && <IsolateBadge childId={childId} />}
              {background && <Tag>bg</Tag>}
              {yielded && <Tag>wait yielded</Tag>}
              {working && (
                <span className="flex items-center gap-1.5 text-brand">
                  <BusyDot /> working
                </span>
              )}
              {duration && <span>{duration}</span>}
            </>
          }
          name="subagent"
          state={call.status}
          title={title}
        />
        {childId !== undefined && (
          <Button
            className="mr-1 h-6 shrink-0 gap-1 px-1.5 font-mono text-[0.6875rem] text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              const entry = Number(
                event.currentTarget.closest('[data-entry-id]')?.getAttribute('data-entry-id'),
              )
              if (id)
                openAgentSource(
                  switchConversation,
                  { conversation: childId, entry: details?.answerId },
                  { conversation: id, ...(entry ? { entry } : {}) },
                )
            }}
            size="sm"
            title={`Show conversation #${childId}`}
            variant="ghost"
          >
            <SquareArrowOutUpRightIcon className="size-3" />
            open #{childId}
          </Button>
        )}
      </div>
      <ToolContent>
        {instruction && (
          <ToolSection label={action === 'start' ? 'Task' : 'Message'}>
            <p className="font-sans text-[0.8125rem] leading-relaxed whitespace-pre-wrap text-foreground/90">
              <MentionText text={instruction} />
            </p>
          </ToolSection>
        )}
        {!finished && call.status !== 'interrupted' && (
          <ToolSection>
            <Shimmer className="text-[0.75rem]">
              {child?.busy ? `${agent || 'subagent'} is working…` : 'starting…'}
            </Shimmer>
          </ToolSection>
        )}
        {call.status === 'done' && action === 'list' ? (
          <ChildList output={call.output} />
        ) : call.status === 'done' && (action === 'land' || action === 'discard') ? (
          <Landed output={call.output} />
        ) : call.status === 'done' && call.output ? (
          <ToolSection
            label={yielded ? 'Wait status' : background && action !== 'wait' ? 'Result' : 'Answer'}
          >
            <Message className="font-sans text-[0.8125rem]" from="assistant">
              <MessageResponse>{call.output}</MessageResponse>
            </Message>
          </ToolSection>
        ) : null}
        {call.status === 'error' && <ToolOutput isError output={call.output} />}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}

/** The `land` and `discard` actions' JSON result: what landed, at which tip, touching which paths. */
function Landed({ output }: { output: string }) {
  let result: LandResult
  try {
    result = JSON.parse(output)
  } catch {
    return <ToolOutput output={output} />
  }
  if (!result.landed)
    return (
      <ToolSection>
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <Trash2Icon className="size-3 shrink-0" />
          {result.text}
        </p>
      </ToolSection>
    )
  const commits = result.commits ?? []
  const files: { path: string; added?: number; removed?: number }[] =
    result.files ?? result.paths?.map((path) => ({ path })) ?? []
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0)
  const removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0)
  return (
    <>
      <ToolSection className="border-l-2 border-l-success/70">
        <p className="flex items-center gap-1.5 text-success">
          <GitMergeIcon className="size-3 shrink-0" />
          {commits.length
            ? `Landed ${result.landed.slice(0, 7)} · ${commits.length} commit${commits.length === 1 ? '' : 's'}`
            : 'Nothing new to land'}
        </p>
        {result.needsRestart && (
          <p className="text-warning">Needs restart to apply server/ or shared/ changes.</p>
        )}
      </ToolSection>
      {commits.length > 0 && (
        <ToolSection label="Commits">
          <ul className="space-y-0.5">
            {commits.map((commit) => (
              <li className="truncate" key={commit} title={commit}>
                <span className="text-muted-foreground">{commit.split(' ')[0]}</span>{' '}
                {commit.slice(commit.indexOf(' ') + 1)}
              </li>
            ))}
          </ul>
        </ToolSection>
      )}
      {files.length > 0 && (
        <ToolSection>
          <div className="flex items-center gap-2 section-label">
            {files.length} changed file{files.length === 1 ? '' : 's'}
            {result.files && (
              <span>
                <span className="text-diff-add">+{added}</span>{' '}
                <span className="text-diff-del">−{removed}</span>
              </span>
            )}
          </div>
          <ul className="space-y-0.5">
            {files.map((file) => {
              const slash = file.path.lastIndexOf('/') + 1
              return (
                <li className="flex min-w-0 items-center gap-2" key={file.path} title={file.path}>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-muted-foreground">{file.path.slice(0, slash)}</span>
                    {file.path.slice(slash)}
                  </span>
                  {'added' in file && (
                    <span className="shrink-0 tabular-nums">
                      <span className="text-diff-add">+{file.added}</span>{' '}
                      <span className="text-diff-del">−{file.removed}</span>
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </ToolSection>
      )}
    </>
  )
}

/** The `list` action's JSON rows. */
function ChildList({ output }: { output: string }) {
  const { switchConversation } = useUltimate()
  let rows: { conversationId: number; agent: string; background: boolean; busy: boolean }[]
  try {
    rows = JSON.parse(output)
  } catch {
    return <ToolOutput output={output} />
  }
  return (
    <ToolSection label={`${rows.length} children`}>
      {rows.map((row) => (
        <button
          className="flex w-full items-center gap-2 rounded-sm px-1 py-0.5 text-left hover:bg-accent/50"
          key={row.conversationId}
          onClick={() => switchConversation(row.conversationId)}
          type="button"
        >
          {row.busy ? <BusyDot /> : <span className="size-1.5" />}
          <span className="text-brand">
            <RunName id={row.conversationId} label={row.agent} />
          </span>
          <span className="text-muted-foreground">#{row.conversationId}</span>
          {row.background && <Tag>bg</Tag>}
        </button>
      ))}
    </ToolSection>
  )
}

/** An error card's report goes into @ultimate's draft, unsent, beside whatever the user had typed there. */
function useErrorReport() {
  const { switchConversation, showSurface, focusComposer } = useUltimate()
  return {
    title: 'Debug with @ultimate',
    send: (report: string) =>
      void api
        .action(StandingAction, { name: 'ultimate' })
        .then((id) => {
          insertIntoComposer(id, report)
          showSurface('agent')
          switchConversation(id)
          requestAnimationFrame(focusComposer)
        })
        .catch((error: unknown) => console.error('Could not open @ultimate', error)),
  }
}

/** With no conversation chosen, show @ultimate's (see `landing`). */
function LandOnUltimate() {
  const loaded = useStore((state) => state.shared !== undefined)
  const [chosen] = useUiState<number | null>('shell.conversation', null)
  const standing = useDocOf(1, StandingDoc)
  const { switchConversation } = useUltimate()
  const target = landing(loaded, chosen ?? undefined, standing)
  useEffect(() => {
    if (target === undefined) return
    if (target !== 'create') return switchConversation(target, { replace: true })
    // A fresh home (a preview) has no @ultimate yet: start it, as its sidebar row does.
    api
      .action(StandingAction, { name: 'ultimate' })
      .then((id) => switchConversation(id, { replace: true }))
      .catch((error: unknown) => console.error('Could not open @ultimate', error))
  }, [target, switchConversation])
  return null
}

export default defineWebExtension({
  tools: { subagent: SubagentCall },
  panels: [
    { id: agentsPanel, title: 'Agents', icon: NetworkIcon, component: AgentsOverview, order: 3 },
  ],
  entries: { 'subagents.instruction': AgentInput, 'subagents.report': AgentInput },
  inbox: AgentInbox,
  provides: [provide(ErrorReport, useErrorReport)],
  slots: { overlay: [DefinitionDialog, LandOnUltimate], 'header.right': [AgentMessages] },
  commands: [
    {
      id: 'subagents.ultimate',
      title: 'Talk to @ultimate',
      keys: 'mod+0',
      run: (context) => talkToUltimate(context),
    },
    {
      id: 'subagents.open',
      title: 'Show agent definitions',
      run: (context) => context.openPanel(agentsPanel),
    },
  ],
})
