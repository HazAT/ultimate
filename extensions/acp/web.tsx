import { BotIcon, ChevronDownIcon, GitBranchIcon, ShieldQuestionIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { CommandGroup, CommandItem } from '@/components/ui/command'
import { Message, MessageResponse } from '@/components/ai/message'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai/reasoning'
import { Shimmer } from '@/components/ai/shimmer'
import { PromptInputSubmit } from '@/components/ai/prompt-input'
import {
  Card,
  ComposerRedirect,
  api,
  cn,
  column,
  defineWebExtension,
  formatTokens,
  getState,
  provide,
  ConversationKind,
  ToolCallBlock,
  useAction,
  useDoc,
  useUltimate,
} from '@/sdk'
import type { ToolCall, ToolCallView } from '@/sdk'
import {
  AgentsAction,
  CancelAction,
  ConfigAction,
  PermitAction,
  PromptAction,
  SessionDoc,
  StartAction,
  TurnDoc,
} from './refs.ts'
import { openPicker, PickerRows } from '../models/ui.tsx'
import { parseConversationId } from '../../lib/ids.ts'
import type { AcpSession, LiveTool, LiveTurn } from './refs.ts'

const toolbarButton =
  'h-7 max-w-48 min-w-0 shrink truncate rounded-md bg-transparent px-1.5 font-mono text-[11.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'

function useSession(): Partial<AcpSession> | undefined {
  const session = useDoc(SessionDoc)
  return session?.agent ? session : undefined
}

function Pickers() {
  const session = useSession()
  const actions = useUltimate()
  if (!session) return null
  const busy = session.status === 'running' || session.status === 'connecting'
  return (
    <>
      <button
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 font-mono text-[11.5px] text-foreground/85 hover:bg-accent"
        onClick={() => openPicker(actions)}
        title={`${session.agentName} over ACP — pick another agent or model`}
        type="button"
      >
        <BotIcon className="size-3.5 text-muted-foreground" />
        {session.agentName}
        <ChevronDownIcon className="size-3 opacity-60" />
      </button>
      {(session.config ?? []).map((option) => (
        <select
          aria-label={option.name}
          className={toolbarButton}
          disabled={busy}
          key={option.id}
          onChange={(event) =>
            void api.action(ConfigAction, { option: option.id, value: event.target.value })
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
    </>
  )
}

const statusText: Record<AcpSession['status'], string> = {
  connecting: 'starting',
  idle: 'ready',
  running: 'working',
  offline: 'offline · starts again with your next message',
  error: 'failed',
}

function Status() {
  const session = useSession()
  if (!session?.status) return null
  return (
    <span className="truncate font-mono text-[11px] text-muted-foreground">
      {session.agentInfo ?? session.agentName} · {statusText[session.status]}
      {session.usage &&
        ` · ${formatTokens(session.usage.used)}/${formatTokens(session.usage.size)} context`}
    </span>
  )
}

function AcpComposer({ core }: { core: ReactNode; dock?: boolean }) {
  const session = useSession()
  if (!session) return core
  const running = session.status === 'running'
  return (
    <ComposerRedirect
      to={{
        placeholder: running
          ? `${session.agentName} is working… (Esc stops it)`
          : `Message ${session.agentName}…`,
        send: (text) => api.action(PromptAction, { text }),
        toolbar: (
          <>
            <Pickers />
            <Stop />
          </>
        ),
      }}
    >
      {core}
    </ComposerRedirect>
  )
}

const callOf = (tool: LiveTool) => tool.call as unknown as ToolCall
const statusOf = (status: LiveTurn['tools'][string]['status']): ToolCallView['status'] => status

function LiveTail() {
  const session = useSession()
  const turn = useDoc(TurnDoc)
  const running = session?.status === 'running' || session?.status === 'connecting'
  if (!session || !running) return null
  const open = turn?.open
  const tools = (turn?.order ?? []).flatMap((id) => {
    const tool = turn?.tools[id]
    return tool ? [tool] : []
  })
  return (
    <div className="flex flex-col gap-3">
      {open?.type === 'thinking' && (
        <Reasoning defaultOpen={false} isStreaming>
          <ReasoningTrigger label="Thinking" />
          <ReasoningContent>{open.text}</ReasoningContent>
        </Reasoning>
      )}
      {open?.type === 'text' && (
        <Message from="assistant">
          <MessageResponse isAnimating>{open.text}</MessageResponse>
        </Message>
      )}
      {tools.map((tool) => (
        <ToolCallBlock
          call={{
            id: callOf(tool).id,
            name: callOf(tool).name,
            args: callOf(tool).arguments,
            status: statusOf(tool.status),
            output: '',
            images: [],
            diagnostics: [],
          }}
          key={callOf(tool).id}
        />
      ))}
      {session.permission ? (
        <Permission ask={session.permission} />
      ) : (
        !open &&
        tools.length === 0 && (
          <span className="flex items-center gap-2 font-mono text-[12px] text-muted-foreground">
            <span className="size-1.5 animate-pulse-dot rounded-full bg-brand" />
            <Shimmer>
              {session.status === 'connecting'
                ? `starting ${session.agentName}…`
                : `${session.agentName} is working…`}
            </Shimmer>
          </span>
        )
      )}
    </div>
  )
}

function Permission({ ask }: { ask: NonNullable<AcpSession['permission']> }) {
  return (
    <Card className="px-3.5 py-3">
      <div className="flex items-center gap-2 text-[13px]">
        <ShieldQuestionIcon className="size-4 shrink-0 text-warning" />
        <span className="min-w-0 flex-1 truncate font-mono">{ask.title}</span>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {ask.options.map((option) => (
          <Button
            key={option.optionId}
            onClick={() => void api.action(PermitAction, { option: option.optionId })}
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

function Stop() {
  const session = useSession()
  if (session?.status !== 'running') return null
  return (
    <PromptInputSubmit
      mode="stop"
      onClick={() => void api.action(CancelAction)}
      title={`Stop ${session.agentName} (Esc)`}
    />
  )
}

const shownSessionRunning = () =>
  (getState().docs[SessionDoc.kind] as Partial<AcpSession> | undefined)?.status === 'running'

function useAgentRows({ query, close }: { query: string; close: () => void }): ReactNode {
  const agents = useAction(AgentsAction)
  const actions = useUltimate()
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = (agents.data ?? []).filter((agent) =>
    terms.every((term) => `acp ${agent.id} ${agent.name} external agent`.includes(term)),
  )
  if (!shown.length) return null
  const start = async (agent: string, isolated: boolean) => {
    close()
    const { id } = await api.action(StartAction, { agent, isolated })
    actions.showSurface('agent')
    actions.switchConversation(parseConversationId(id))
  }
  return (
    <CommandGroup
      heading={
        <span className="flex items-center gap-2">
          acp
          <span className="truncate text-muted-foreground/60">
            external agents · their own login, loop and tools
          </span>
          <span className="ml-auto text-muted-foreground/60">↵ opens a new conversation</span>
        </span>
      }
    >
      {shown.map((agent) => (
        <CommandItem
          className={cn('gap-2 py-1 font-mono text-[12px]', !agent.installed && 'opacity-60')}
          disabled={!agent.installed}
          key={agent.id}
          onSelect={() => void start(agent.id, false)}
          value={`acp/${agent.id}`}
        >
          <BotIcon className="size-3.5 text-muted-foreground" />
          <span className="shrink-0 text-foreground">{agent.id}</span>
          <span className="min-w-0 truncate font-sans text-[12px] text-muted-foreground/80">
            {agent.name}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-3 pl-3 text-[11px] text-muted-foreground">
            {agent.installed ? (
              <button
                className="flex items-center gap-1 rounded-sm px-1 hover:bg-accent hover:text-foreground"
                onClick={(event) => {
                  event.stopPropagation()
                  void start(agent.id, true)
                }}
                onPointerDown={(event) => event.stopPropagation()}
                title={`Start ${agent.name} in a new worktree of this project`}
                type="button"
              >
                <GitBranchIcon className="size-3" />
                worktree
              </button>
            ) : (
              <span className="text-warning/80">{agent.command} not installed</span>
            )}
            <span className="text-muted-foreground/60">
              {[agent.command, ...agent.args].join(' ')}
            </span>
          </span>
        </CommandItem>
      ))}
    </CommandGroup>
  )
}

export default defineWebExtension({
  composer: AcpComposer,
  slots: {
    'composer.status': [Status],
    'transcript.end': [
      () => (
        <div className={cn(column(), 'empty:hidden')}>
          <LiveTail />
        </div>
      ),
    ],
  },
  commands: [
    {
      id: 'acp.stop',
      title: 'Stop the external agent',
      keys: 'escape',
      whileTyping: true,
      when: shownSessionRunning,
      run: () => api.action(CancelAction),
    },
  ],
  provides: [
    provide(PickerRows, useAgentRows),
    provide(ConversationKind, (conversation) =>
      conversation?.label === 'acp' ? 'acp' : undefined,
    ),
  ],
})
