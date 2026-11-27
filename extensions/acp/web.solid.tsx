import { Bot, ChevronDown, ShieldQuestion, Square } from '@lucide/solid'
import { createMemo, For, Show } from 'solid-js'
import type { JSX } from '@solidjs/web'
import { Message, MessageContent } from '@/components/ai/message.solid.tsx'
import { Reasoning } from '@/components/ai/reasoning.solid.tsx'
import { Shimmer } from '@/components/ai/shimmer.solid.tsx'
import { Markdown } from '@/components/markdown/markdown.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.solid.tsx'
import {
  api,
  Card,
  column,
  defineWebExtension,
  EmptyTranscript,
  errorMessage,
  formatTokens,
  getState,
  notify,
  PromptBox,
  provide,
  showSurface,
  switchConversation,
  ToolCallBlock,
  useAction,
  useConversationId,
  useDoc,
  writerNow,
  writingAs,
} from '@/sdk/solid'
import type { SolidComposerProps, ToolCallView } from '@/sdk/solid'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { ToolCall } from '@earendil-works/pi-ai'
import { parseConversationId } from '../../lib/ids.shared.ts'
import { ExternalSpeaker, SpeakerBadge } from '../messages/ui.solid.tsx'
import { PickerRows } from '../models/ui.solid.tsx'
import { AntigravityMark } from './mark.solid.tsx'
import {
  AvailableAction,
  CancelAction,
  ConfigAction,
  PermitAction,
  PromptAction,
  SessionDoc,
  StartAction,
  TurnDoc,
} from './refs.ts'
import type { AcpSession, ConfigOption, LiveTool, PermissionAsk } from './refs.ts'

const toolbarButton =
  'inline-flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 font-mono text-[11.5px] font-normal text-muted-foreground hover:bg-accent hover:text-foreground'
const onlyPerson = 'Only you can drive an Antigravity session.'

const statusText: Record<AcpSession['status'], string> = {
  connecting: 'starting',
  idle: 'ready',
  running: 'working',
  offline: 'offline · resumes with your next message',
  error: 'failed',
}

export function AcpComposer(props: SolidComposerProps) {
  const id = useConversationId()
  const session = useDoc(SessionDoc)
  const active = () => !!session()?.status && id() !== undefined
  const running = () => session()?.status === 'running'
  const connecting = () => session()?.status === 'connecting'
  return (
    <Show when={active() && id()} keyed fallback={props.core}>
      {(conversation) => (
        <div class={column(props.dock)} data-ui="composer">
          <PromptBox
            accepts={{ images: false, files: false }}
            actions={
              <Show when={running()}>
                <Button
                  aria-label={`Stop Antigravity in #${conversation}`}
                  class="ml-1 size-7 rounded-md pointer-coarse:size-9"
                  data-agent-confirm={onlyPerson}
                  onClick={() => api.action(CancelAction, null, { conversationId: conversation })}
                  size="icon"
                  title="Stop (Esc)"
                  variant="secondary"
                >
                  <Square class="size-3 fill-current" />
                </Button>
              </Show>
            }
            autofocus
            conversation={conversation}
            dictation={false}
            disabled={running()}
            draft={`acp-${conversation}`}
            id={props.dock ? `composer-input-${conversation}` : 'composer-input'}
            loading={connecting()}
            name={`Antigravity #${conversation}`}
            onSubmit={({ text }) =>
              api.action(PromptAction, { text }, { conversationId: conversation })
            }
            placeholder={
              running() ? 'Antigravity is working… (Esc stops it)' : 'Message Antigravity…'
            }
            running={running()}
            toolbar={
              <div class="flex min-w-0 items-center gap-1 overflow-x-auto">
                <span class="inline-flex shrink-0 items-center gap-1 px-1.5 font-mono text-[11.5px] text-foreground/85">
                  <AntigravityMark class="size-3.5" /> Antigravity
                </span>
                <For each={session()?.config} keyed={(option) => option.id}>
                  {(option) => (
                    <ConfigPicker
                      disabled={session()?.status !== 'idle'}
                      id={conversation}
                      option={option()}
                    />
                  )}
                </For>
              </div>
            }
          />
          <div class="truncate pt-1.5 font-mono text-[11px] text-muted-foreground">
            ACP · {statusText[session()?.status ?? 'offline']}
            <Show when={session()?.usage}>
              {(usage) => ` · ${formatTokens(usage().used)}/${formatTokens(usage().size)} context`}
            </Show>
          </div>
        </div>
      )}
    </Show>
  )
}

function AcpEmpty(props: { conversation: ConversationId; core: JSX.Element }) {
  const session = useDoc(SessionDoc)
  return (
    <Show when={session()?.status} fallback={props.core}>
      <Show when={session()?.status !== 'connecting'}>
        <div class="mx-auto flex max-w-sm flex-col items-center gap-2 px-4 text-center">
          <Bot class="size-5 text-muted-foreground" />
          <p class="text-[13px]">Antigravity</p>
          <p class="text-[12px] text-muted-foreground">Type a message to drive your ACP session.</p>
        </div>
      </Show>
    </Show>
  )
}

function ConfigPicker(props: { id: ConversationId; option: ConfigOption; disabled: boolean }) {
  const current = () => props.option.options.find((choice) => choice.value === props.option.value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Antigravity ${props.option.name} (${props.option.id}) in #${props.id}`}
        class={toolbarButton}
        disabled={props.disabled}
        title={props.option.name}
      >
        <span class="truncate">{current()?.name || props.option.name}</span>
        <ChevronDown class="size-3 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top">
        <DropdownMenuRadioGroup
          onValueChange={(value) =>
            api
              .action(
                ConfigAction,
                { option: props.option.id, value },
                { conversationId: props.id },
              )
              .catch((failure: unknown) =>
                notify({ level: 'error', message: errorMessage(failure) }),
              )
          }
          value={props.option.value}
        >
          <For each={props.option.options} keyed={(choice) => choice.value}>
            {(choice) => (
              <DropdownMenuRadioItem
                aria-label={`Antigravity ${props.option.name} (${props.option.id}): ${choice().name} (${choice().value}) in #${props.id}`}
                data-agent-confirm={onlyPerson}
                value={choice().value}
              >
                {choice().name}
              </DropdownMenuRadioItem>
            )}
          </For>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function toolView(tool: LiveTool): ToolCallView {
  const call = tool.call as unknown as ToolCall
  return {
    id: call.id,
    name: call.name,
    args: call.arguments,
    status: tool.status,
    output: '',
    images: [],
    diagnostics: [],
  }
}

export function LiveTail() {
  const id = useConversationId()
  const session = useDoc(SessionDoc)
  const turn = useDoc(TurnDoc)
  const active = () => session()?.status === 'running' || session()?.status === 'connecting'
  const open = () => turn()?.open
  const modelName = () => {
    const selected = session()?.config?.find((option) => option.category === 'model')
    return selected?.options.find((choice) => choice.value === selected.value)?.name
  }
  return (
    <Show when={active() && id()} keyed>
      {(conversation) => (
        <div class="flex flex-col gap-3">
          <Show when={open()?.type === 'thinking'}>
            <Reasoning label={`Thinking in Antigravity #${conversation}`} streaming>
              {open()?.text ?? ''}
            </Reasoning>
          </Show>
          <Show when={open()?.type === 'text'}>
            <Message class="gap-3" from="assistant">
              <div class="flex min-h-6 items-center font-mono text-[11px]">
                <SpeakerBadge
                  icon={AntigravityMark}
                  name="antigravity"
                  role={modelName() && `· ${modelName()}`}
                  title="Antigravity"
                />
              </div>
              <MessageContent>
                <Markdown streaming text={open()?.text ?? ''} />
              </MessageContent>
            </Message>
          </Show>
          <For each={turn()?.order}>
            {(key) => (
              <Show when={turn()?.tools[key]}>
                {(tool) => <ToolCallBlock call={toolView(tool())} />}
              </Show>
            )}
          </For>
          <Show when={session()?.permission} keyed>
            {(ask) => <Permission ask={ask} id={conversation} />}
          </Show>
          <Show when={!session()?.permission && !open() && !turn()?.order.length}>
            <span class="flex items-center gap-2 font-mono text-[12px] text-muted-foreground">
              <span class="size-1.5 animate-pulse-dot rounded-full bg-brand" />
              <Shimmer>
                {session()?.status === 'connecting'
                  ? 'Starting Antigravity…'
                  : 'Antigravity is working…'}
              </Shimmer>
            </span>
          </Show>
        </div>
      )}
    </Show>
  )
}

function Permission(props: { ask: PermissionAsk; id: ConversationId }) {
  return (
    <Card class="px-3.5 py-3">
      <div class="flex items-center gap-2 text-[13px]">
        <ShieldQuestion class="size-4 shrink-0 text-warning" />
        <span class="min-w-0 flex-1 break-words font-mono">{props.ask.title}</span>
      </div>
      <div class="mt-2.5 flex flex-wrap gap-1.5">
        <For each={props.ask.options} keyed={(option) => option.optionId}>
          {(option) => (
            <Button
              aria-label={`${option().name} (${option().optionId}) for Antigravity #${props.id}`}
              data-agent-confirm={onlyPerson}
              onClick={() =>
                api.action(
                  PermitAction,
                  { request: props.ask.id, option: option().optionId },
                  { conversationId: props.id },
                )
              }
              size="sm"
              variant={option().kind.startsWith('allow') ? 'default' : 'outline'}
            >
              {option().name}
            </Button>
          )}
        </For>
      </div>
    </Card>
  )
}

async function start(isolated: boolean) {
  const source = writerNow()
  const { id } = await api.action(StartAction, { isolated })
  writingAs(source, () => {
    showSurface('agent')
    switchConversation(parseConversationId(id))
  })
}

export function agentRows(input: () => { query: string }) {
  const availability = useAction(AvailableAction)
  return createMemo(() => {
    const terms = input().query.toLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.every((term) => 'antigravity acp agy'.includes(term))) return undefined
    const installed = availability.data()
    return {
      group: 'acp',
      rows: [
        {
          value: 'acp/antigravity',
          title: 'Antigravity',
          icon: AntigravityMark,
          detail:
            installed === undefined
              ? 'Checking for agy…'
              : installed
                ? 'Enter to start · agy acp'
                : 'Install agy to start',
          disabled: installed !== true,
          confirm: onlyPerson,
          activate: () => start(false),
          worktree: { title: 'Start Antigravity in a new worktree', activate: () => start(true) },
        },
      ],
    }
  })
}

export default defineWebExtension({
  composer: AcpComposer,
  slots: { 'transcript.end': [LiveTail] },
  commands: [
    {
      id: 'acp.stop',
      title: 'Stop Antigravity',
      keys: 'escape',
      whileTyping: true,
      when: ({ conversationId }) => {
        const { view, viewsOf } = getState()
        const current =
          conversationId === undefined || view?.conversation.id === conversationId
            ? view
            : viewsOf[conversationId]
        const session = current?.docs[SessionDoc.kind] as Partial<AcpSession> | undefined
        return session?.status === 'running'
      },
      run: ({ conversationId }) => api.action(CancelAction, null, { conversationId }),
    },
  ],
  provides: [
    provide(PickerRows, agentRows),
    provide(EmptyTranscript, AcpEmpty),
    provide(ExternalSpeaker, (entry) => () => {
      const answer = entry().model?.find((message) => message.role === 'assistant')
      if (answer?.api !== 'acp') return undefined
      return {
        name: 'antigravity',
        title: 'Antigravity',
        icon: AntigravityMark,
        ...(answer.model === 'Antigravity' ? {} : { model: answer.model }),
      }
    }),
  ],
})
