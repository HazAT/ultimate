/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import { GitBranch, GitMerge, SquareArrowOutUpRight, Trash2 } from '@lucide/solid'
import { createMemo, For, Match, Show, Switch } from 'solid-js'
import type { JSX } from '@solidjs/web'
import { Message } from '@/components/ai/message.solid.tsx'
import { Shimmer } from '@/components/ai/shimmer.solid.tsx'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool.solid.tsx'
import { Markdown, MentionText } from '@/components/markdown/markdown.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import { Provided, useToolDuration } from '@/sdk/parts.solid.tsx'
import {
  ROOT,
  cn,
  plural,
  switchConversation,
  useConversationId,
  useConversationSummary,
  useDocOf,
} from '@/sdk/solid'
import type { SolidToolProps } from '@/sdk/solid'
import { parseConversationId } from '../../lib/ids.ts'
import { ConversationTaskChip } from '../conversations/ui.solid.tsx'
import { WorkspacesDoc } from '../workspaces/refs.ts'
import type { LandResult } from '../workspaces/types.ts'
import { openAgentSource, RunName } from './run-name.solid.tsx'

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const workspaceLabels = { preparing: 'Setting up…', failed: 'Setup failed', removed: 'Removed' }

function BusyDot() {
  return <span class="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand" />
}

function Tag(props: { children: JSX.Element; class?: string }) {
  return (
    <span
      class={cn(
        'shrink-0 rounded-sm border border-border/80 px-1 text-[10px] leading-4 text-muted-foreground',
        props.class,
      )}
    >
      {props.children}
    </span>
  )
}

function IsolateBadge(props: { childId?: ConversationId }) {
  const workspaces = useDocOf(() => ROOT, WorkspacesDoc)
  const workspace = () => workspaces()?.items[String(props.childId)]
  const state = () => {
    const value = workspace()?.state
    return value === 'ready' ? undefined : value
  }
  return (
    <Show when={workspace()}>
      {(item) => (
        <span class="flex items-center gap-1 font-mono" title={`${item().branch}\n${item().path}`}>
          <GitBranch class="size-3 shrink-0" />
          <Show when={state()}>
            {(status) => (
              <Tag
                class={cn(
                  'font-mono',
                  status() === 'failed' ? 'border-error/40 text-error' : 'text-muted-foreground/70',
                )}
              >
                <span title={item().landed && `Last landed ${item().landed?.slice(0, 7)}`}>
                  {workspaceLabels[status()]}
                </span>
              </Tag>
            )}
          </Show>
        </span>
      )}
    </Show>
  )
}

type Details = {
  conversationId?: ConversationId
  background?: boolean
  yielded?: boolean
  answerId?: number
}

export function SubagentCall(props: SolidToolProps) {
  const call = () => props.call
  const duration = useToolDuration(call)
  const parentId = useConversationId()
  const action = () => text(call().args.action) || 'start'
  const details = () => call().details as Details | undefined
  const childId = () => {
    const id = call().args.id
    return (
      details()?.conversationId ?? (typeof id === 'number' ? parseConversationId(id) : undefined)
    )
  }
  const summary = useConversationSummary(childId)
  const agent = () => summary()?.label || text(call().args.label) || text(call().args.agent)
  const background = () => call().args.background === true || details()?.background === true
  const instruction = () => text(action() === 'start' ? call().args.task : call().args.text)
  const finished = () => call().status === 'done' || call().status === 'error'
  const yielded = () => details()?.yielded === true
  const working = () => summary()?.busy && (background() || yielded() || !finished())

  return (
    <Tool defaultOpen={!finished() || call().status === 'error'}>
      <div class="flex items-center">
        <ToolHeader
          aria-label={`Subagent ${action()} call ${call().id.slice(-8)}`}
          class="min-w-0 flex-1"
          meta={
            <>
              <IsolateBadge childId={childId()} />
              <Show when={background()}>
                <Tag>bg</Tag>
              </Show>
              <Show when={yielded()}>
                <Tag>wait yielded</Tag>
              </Show>
              <Show when={working()}>
                <span class="flex items-center gap-1.5 text-brand">
                  <BusyDot /> working
                </span>
              </Show>
              <Show when={duration()}>{(value) => <span>{value()}</span>}</Show>
            </>
          }
          name="subagent"
          state={call().status}
          title={
            <Switch
              fallback={
                <>
                  {action()} <span class="text-foreground/80">#{childId() ?? '?'}</span>
                  {call().args.steer === false && ' (follow-up)'} {instruction()}
                </>
              }
            >
              <Match when={action() === 'start'}>
                <span class="text-brand">
                  <RunName id={childId()} label={agent() || '…'} />
                </span>{' '}
                {instruction()}
              </Match>
              <Match when={action() === 'list'}>list children</Match>
            </Switch>
          }
        />
        <Show when={childId()}>
          {(id) => (
            <Provided
              input={{ conversation: id(), on: `call ${call().id.slice(-8)}` }}
              last
              point={ConversationTaskChip}
            />
          )}
        </Show>
        <Show when={childId()}>
          {(child) => (
            <Button
              aria-label={`Show conversation #${child()} (call ${call().id.slice(-8)})`}
              class="mr-1 h-6 shrink-0 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
              onClick={(event) => {
                const conversation = parentId()
                if (conversation === undefined) return
                const entry = Number(
                  event.currentTarget.closest('[data-entry-id]')?.getAttribute('data-entry-id'),
                )
                openAgentSource(
                  switchConversation,
                  { conversation: child(), entry: details()?.answerId },
                  { conversation, ...(entry ? { entry } : {}) },
                )
              }}
              size="sm"
              title={`Show conversation #${child()}`}
              variant="ghost"
            >
              <SquareArrowOutUpRight class="size-3" />
              open #{child()}
            </Button>
          )}
        </Show>
      </div>
      <ToolContent>
        <Show when={instruction()}>
          {(value) => (
            <ToolSection label={action() === 'start' ? 'Task' : 'Message'}>
              <p class="font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/90">
                <MentionText text={value()} />
              </p>
            </ToolSection>
          )}
        </Show>
        <Show when={!finished() && call().status !== 'interrupted'}>
          <ToolSection>
            <Shimmer class="text-[12px]">
              {summary()?.busy ? `${agent() || 'subagent'} is working…` : 'starting…'}
            </Shimmer>
          </ToolSection>
        </Show>
        <Show when={call().status === 'done'}>
          <Switch>
            <Match when={action() === 'list'}>
              <ChildList output={call().output} />
            </Match>
            <Match when={action() === 'land' || action() === 'discard'}>
              <Landed output={call().output} />
            </Match>
            <Match when={call().output}>
              <ToolSection
                label={
                  yielded()
                    ? 'Wait status'
                    : background() && action() !== 'wait'
                      ? 'Result'
                      : 'Answer'
                }
              >
                <Message class="font-sans text-[13px]" from="assistant">
                  <Markdown text={call().output} />
                </Message>
              </ToolSection>
            </Match>
          </Switch>
        </Show>
        <Show when={call().status === 'error'}>
          <ToolOutput isError output={call().output} />
        </Show>
        <ToolDiagnostics diagnostics={call().diagnostics} />
      </ToolContent>
    </Tool>
  )
}

function parseOutput(output: string): unknown {
  try {
    return JSON.parse(output) as unknown
  } catch {
    return undefined
  }
}

type ChangedFile = { path: string; added?: number; removed?: number }

function Landed(props: { output: string }) {
  const result = createMemo(() => parseOutput(props.output) as LandResult | undefined)
  const commits = () => result()?.commits ?? []
  const files = (): ChangedFile[] =>
    result()?.files ?? result()?.paths?.map((path) => ({ path })) ?? []
  const added = () => files().reduce((sum, file) => sum + (file.added ?? 0), 0)
  const removed = () => files().reduce((sum, file) => sum + (file.removed ?? 0), 0)
  return (
    <Switch fallback={<ToolOutput output={props.output} />}>
      <Match when={result() && !result()?.landed}>
        <ToolSection>
          <p class="flex items-center gap-1.5 text-muted-foreground">
            <Trash2 class="size-3 shrink-0" />
            {result()?.text}
          </p>
        </ToolSection>
      </Match>
      <Match when={result()?.landed}>
        {(sha) => (
          <>
            <ToolSection class="border-l-2 border-l-success/70">
              <p class="flex items-center gap-1.5 text-success">
                <GitMerge class="size-3 shrink-0" />
                {commits().length
                  ? `Landed ${sha().slice(0, 7)} · ${plural(commits().length, 'commit')}`
                  : 'Nothing new to land'}
              </p>
              <Show when={result()?.needsRestart}>
                <p class="text-warning">Needs restart to apply core or package changes.</p>
              </Show>
            </ToolSection>
            <Show when={commits().length}>
              <ToolSection label="Commits">
                <ul class="space-y-0.5">
                  <For each={commits()}>
                    {(commit) => (
                      <li class="truncate" title={commit}>
                        <span class="text-muted-foreground">{commit.split(' ')[0]}</span>{' '}
                        {commit.slice(commit.indexOf(' ') + 1)}
                      </li>
                    )}
                  </For>
                </ul>
              </ToolSection>
            </Show>
            <Show when={files().length}>
              <ToolSection>
                <div class="flex items-center gap-2 section-label">
                  {plural(files().length, 'changed file')}
                  <Show when={result()?.files}>
                    <span>
                      <span class="text-diff-add">+{added()}</span>{' '}
                      <span class="text-diff-del">−{removed()}</span>
                    </span>
                  </Show>
                </div>
                <ul class="space-y-0.5">
                  <For each={files()} keyed={(file) => file.path}>
                    {(file) => {
                      const slash = () => file().path.lastIndexOf('/') + 1
                      return (
                        <li class="flex min-w-0 items-center gap-2" title={file().path}>
                          <span class="min-w-0 flex-1 truncate">
                            <span class="text-muted-foreground">
                              {file().path.slice(0, slash())}
                            </span>
                            {file().path.slice(slash())}
                          </span>
                          <Show when={'added' in file()}>
                            <span class="shrink-0 tabular-nums">
                              <span class="text-diff-add">+{file().added}</span>{' '}
                              <span class="text-diff-del">−{file().removed}</span>
                            </span>
                          </Show>
                        </li>
                      )
                    }}
                  </For>
                </ul>
              </ToolSection>
            </Show>
          </>
        )}
      </Match>
    </Switch>
  )
}

type Child = { conversationId: ConversationId; agent: string; background: boolean; busy: boolean }

function ChildList(props: { output: string }) {
  const rows = createMemo(() => {
    const output = parseOutput(props.output)
    return Array.isArray(output) ? (output as Child[]) : undefined
  })
  return (
    <Show when={rows()} fallback={<ToolOutput output={props.output} />}>
      {(children) => (
        <ToolSection label={`${children().length} children`}>
          <For each={children()} keyed={(child) => child.conversationId}>
            {(child) => (
              <Button
                aria-label={`Visit listed child #${child().conversationId}`}
                class="flex w-full items-center justify-start gap-2 rounded-sm px-1 py-0.5 text-left text-[12px] font-normal hover:bg-accent/50"
                onClick={() => switchConversation(child().conversationId)}
                size={null}
                variant={null}
              >
                <Show when={child().busy} fallback={<span class="size-1.5" />}>
                  <BusyDot />
                </Show>
                <span class="text-brand">
                  <RunName id={child().conversationId} label={child().agent} />
                </span>
                <span class="text-muted-foreground/70">#{child().conversationId}</span>
                <Show when={child().background}>
                  <Tag>bg</Tag>
                </Show>
              </Button>
            )}
          </For>
        </ToolSection>
      )}
    </Show>
  )
}
