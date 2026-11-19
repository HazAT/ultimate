import { BotIcon, GitBranchIcon, ShieldQuestionIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import type { AcpSession, LiveTool, LiveTurn } from './refs.ts'

const toolbarButton =
  'h-7 max-w-48 min-w-0 shrink truncate rounded-md bg-transparent px-1.5 font-mono text-[11.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'

function useSession(): Partial<AcpSession> | undefined {
  const session = useDoc(SessionDoc)
  return session?.agent ? session : undefined
}

function Pickers() {
  const session = useSession()
  if (!session) return null
  const busy = session.status === 'running' || session.status === 'connecting'
  return (
    <>
      <span className="flex h-7 shrink-0 items-center gap-1.5 px-1.5 font-mono text-[11.5px] text-muted-foreground">
        <BotIcon className="size-3.5" />
        {session.agentName}
      </span>
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

function NewAcpConversation() {
  const agents = useAction(AgentsAction)
  const actions = useUltimate()
  const start = async (agent: string, isolated: boolean) => {
    const { id } = await api.action(StartAction, { agent, isolated })
    actions.showSurface('agent')
    actions.switchConversation(id as never)
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex h-6 items-center gap-1.5 rounded-md px-1.5 font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Start a conversation with an external agent"
          type="button"
        >
          <BotIcon className="size-3.5" />
          acp
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-mono text-[11px] text-muted-foreground">
          External agent, in this project
        </DropdownMenuLabel>
        {(agents.data ?? []).map((agent) => (
          <DropdownMenuItem
            disabled={!agent.installed}
            key={agent.id}
            onSelect={() => void start(agent.id, false)}
          >
            <BotIcon className="size-3.5" />
            <span className="flex-1">{agent.name}</span>
            {!agent.installed && (
              <span className="font-mono text-[10px] text-muted-foreground">not installed</span>
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuLabel className="font-mono text-[11px] text-muted-foreground">
          In a new worktree
        </DropdownMenuLabel>
        {(agents.data ?? [])
          .filter((agent) => agent.installed)
          .map((agent) => (
            <DropdownMenuItem key={agent.id} onSelect={() => void start(agent.id, true)}>
              <GitBranchIcon className="size-3.5" />
              <span className="flex-1">{agent.name}</span>
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
    'header.right': [NewAcpConversation],
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
    provide(ConversationKind, (conversation) =>
      conversation?.label === 'acp' ? 'acp' : undefined,
    ),
  ],
})
