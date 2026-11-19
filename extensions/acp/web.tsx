import { BotIcon, PlusIcon, ShieldQuestionIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  Conversation as Log,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai/message'
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai/prompt-input'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai/reasoning'
import { Tool, ToolContent, ToolHeader, ToolOutput, ToolSection } from '@/components/ai/tool'
import type { ToolState } from '@/components/ai/tool'
import { Shimmer } from '@/components/ai/shimmer'
import {
  Card,
  Header,
  ROOT,
  StatusLine,
  api,
  cn,
  defineWebExtension,
  formatTokens,
  useAction,
  useDocOf,
  useExtensionUiState,
} from '@/sdk'
import {
  AgentsAction,
  CancelAction,
  ConfigAction,
  DeleteAction,
  PermitAction,
  PromptAction,
  StartAction,
  ThreadsDoc,
} from './refs.ts'
import type { AgentStatus, Thread, ThreadItem, ToolItem } from './refs.ts'

const toolState = (status: ToolItem['status'], running: boolean): ToolState =>
  status === 'completed'
    ? 'done'
    : status === 'failed'
      ? 'error'
      : running
        ? status === 'in_progress'
          ? 'running'
          : 'pending'
        : 'interrupted'

function Item({
  item,
  running,
  last,
}: {
  item: ThreadItem
  running: boolean
  last: boolean
}): ReactNode {
  switch (item.kind) {
    case 'user':
      return (
        <Message from="user">
          <MessageContent className="whitespace-pre-wrap">{item.text}</MessageContent>
        </Message>
      )
    case 'agent':
      return (
        <Message from="assistant">
          <MessageContent>
            <MessageResponse isAnimating={running && last}>{item.text}</MessageResponse>
          </MessageContent>
        </Message>
      )
    case 'thought':
      return (
        <Reasoning isStreaming={running && last}>
          <ReasoningTrigger />
          <ReasoningContent>{item.text}</ReasoningContent>
        </Reasoning>
      )
    case 'tool':
      return (
        <Tool>
          <ToolHeader
            meta={item.toolKind}
            name=""
            state={toolState(item.status, running)}
            title={item.title || item.paths[0] || 'tool'}
          />
          <ToolContent>
            {item.paths.length > 0 && (
              <ToolSection label="Files">
                {item.paths.map((path) => (
                  <div className="truncate" key={path}>
                    {path}
                  </div>
                ))}
              </ToolSection>
            )}
            {item.input && <ToolOutput output={item.input} />}
            {item.output && <ToolOutput output={item.output} />}
          </ToolContent>
        </Tool>
      )
    case 'plan':
      return (
        <div className="rounded-md border border-border/70 px-3 py-2 font-mono text-[12px]">
          <div className="section-label mb-1">Plan</div>
          {item.entries.map((entry, index) => (
            <div
              className={cn(
                entry.status === 'completed' && 'text-muted-foreground line-through',
                entry.status === 'in_progress' && 'text-brand',
              )}
              key={index}
            >
              {entry.content}
            </div>
          ))}
        </div>
      )
    case 'error':
      break
  }
  return <p className="font-mono text-[12px] text-error">{item.text}</p>
}

function Permission({ thread }: { thread: Thread }) {
  const ask = thread.permission
  if (!ask) return null
  return (
    <Card className="px-3 py-2.5">
      <div className="flex items-center gap-2 text-[13px]">
        <ShieldQuestionIcon className="size-4 text-warning" />
        <span className="min-w-0 flex-1 truncate">{ask.title}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {ask.options.map((option) => (
          <Button
            key={option.optionId}
            onClick={() =>
              void api.action(PermitAction, { thread: thread.id, option: option.optionId })
            }
            size="sm"
            variant={option.kind.startsWith('allow') ? 'default' : 'outline'}
          >
            {option.name}
          </Button>
        ))}
      </div>
    </Card>
  )
}

function Composer({ thread }: { thread: Thread }) {
  const [draft, setDraft] = useState('')
  const running = thread.status === 'running'
  const busy = running || thread.status === 'connecting'
  const send = () => {
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
    void api.action(PromptAction, { thread: thread.id, text })
  }
  return (
    <PromptInput
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
    >
      <PromptInputTextarea
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            send()
          }
        }}
        placeholder={`Message ${thread.agentName}…`}
        value={draft}
      />
      <PromptInputFooter>
        <PromptInputTools>
          {thread.config.map((option) => (
            <select
              aria-label={option.name}
              className="h-7 max-w-48 rounded-md border border-border/70 bg-transparent px-1.5 font-mono text-[11px] text-muted-foreground"
              disabled={busy}
              key={option.id}
              onChange={(event) =>
                void api.action(ConfigAction, {
                  thread: thread.id,
                  option: option.id,
                  value: event.target.value,
                })
              }
              title={option.name}
              value={option.value}
            >
              {option.options.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.name}
                </option>
              ))}
            </select>
          ))}
        </PromptInputTools>
        <PromptInputSubmit
          disabled={!running && (!draft.trim() || busy)}
          mode={running ? 'stop' : 'send'}
          onClick={running ? () => void api.action(CancelAction, { thread: thread.id }) : undefined}
        />
      </PromptInputFooter>
    </PromptInput>
  )
}

const statusText: Record<Thread['status'], string> = {
  connecting: 'starting',
  idle: 'ready',
  running: 'working',
  offline: 'offline · resumes on next message',
  error: 'failed',
}

function ThreadView({ thread }: { thread: Thread }) {
  const running = thread.status === 'running'
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-border/70 px-4 py-2">
        <span className="min-w-0 flex-1 truncate text-[13px]">{thread.title}</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {thread.agentInfo ?? thread.agentName} · {statusText[thread.status]}
          {thread.usage &&
            ` · ${formatTokens(thread.usage.used)}/${formatTokens(thread.usage.size)}`}
        </span>
        <Button
          aria-label="Delete thread"
          onClick={() => void api.action(DeleteAction, { thread: thread.id })}
          size="icon"
          variant="ghost"
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
      <Log className="min-h-0">
        <ConversationContent className="mx-auto w-full max-w-3xl gap-4 px-4 py-5">
          {thread.items.length === 0 && (
            <p className="font-mono text-[12px] text-muted-foreground">
              {thread.status === 'connecting'
                ? `Starting ${thread.agentName}…`
                : `${thread.agentName} runs its own loop, tools and model in ${thread.cwd}. Every turn starts with your message.`}
            </p>
          )}
          {thread.items.map((item, index) => (
            <Item
              item={item}
              key={item.kind === 'tool' ? item.id : index}
              last={index === thread.items.length - 1}
              running={running}
            />
          ))}
          {running && thread.items.at(-1)?.kind === 'user' && (
            <Shimmer className="font-mono text-[12px]">working…</Shimmer>
          )}
          {thread.error && thread.items.at(-1)?.kind !== 'error' && (
            <p className="font-mono text-[12px] text-error">{thread.error}</p>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Log>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pb-4">
        <Permission thread={thread} />
        <Composer thread={thread} />
      </div>
    </div>
  )
}

function NewThread({ agents, onStart }: { agents: AgentStatus[]; onStart: (id: string) => void }) {
  return (
    <div className="flex flex-col gap-1 px-2 py-2">
      <div className="section-label px-1">New thread</div>
      {agents.map((agent) => (
        <button
          className="flex items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-accent/60 disabled:opacity-50"
          disabled={!agent.installed}
          key={agent.id}
          onClick={async () => onStart((await api.action(StartAction, { agent: agent.id })).id)}
          title={`${agent.command} ${agent.args.join(' ')}`}
          type="button"
        >
          <PlusIcon className="size-3.5 text-muted-foreground" />
          <span className="flex-1 truncate">{agent.name}</span>
          {!agent.installed && (
            <span className="font-mono text-[10px] text-muted-foreground">not installed</span>
          )}
        </button>
      ))}
    </div>
  )
}

function Agents() {
  const threads = useDocOf(ROOT, ThreadsDoc)?.threads ?? []
  const agents = useAction(AgentsAction)
  const [selected, setSelected] = useExtensionUiState<string | null>('selected', null)
  const thread = threads.find((one) => one.id === selected) ?? threads.at(-1)
  return (
    <>
      <Header>
        <span className="text-[13px]">External agents</span>
      </Header>
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-border/70 bg-sidebar">
          {agents.data && <NewThread agents={agents.data} onStart={setSelected} />}
          <div className="section-label px-3 pt-2">Threads</div>
          {threads.toReversed().map((one) => (
            <button
              className={cn(
                'block w-full px-3 py-1.5 text-left hover:bg-accent/60',
                one.id === thread?.id && 'bg-accent',
              )}
              key={one.id}
              onClick={() => setSelected(one.id)}
              type="button"
            >
              <span className="block truncate text-[13px]">{one.title}</span>
              <span className="block font-mono text-[11px] text-muted-foreground">
                {one.agentName} · {statusText[one.status]}
              </span>
            </button>
          ))}
        </nav>
        {thread ? (
          <ThreadView thread={thread} />
        ) : (
          <p className="m-auto max-w-sm text-center text-[13px] text-muted-foreground">
            Start a thread with an external agent. It runs its own loop, tools and model through the
            Agent Client Protocol; you drive every turn.
          </p>
        )}
      </div>
      <StatusLine />
    </>
  )
}

export default defineWebExtension({
  surfaces: [
    {
      id: 'acp',
      title: 'ACP',
      icon: BotIcon,
      description: 'External coding agents over the Agent Client Protocol',
      order: 50,
      component: Agents,
    },
  ],
})
