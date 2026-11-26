import { defineDoc } from '@earendil-works/pi-durable'
import type { ConversationId, JsonObject, Tx } from '@earendil-works/pi-durable'
import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai'
import type { ExtensionHost } from '../../server/extensions.ts'
import { SessionDoc, TurnDoc } from './refs.ts'
import type { AcpSession, ConfigOption, LiveTool, LiveTurn } from './refs.ts'
import { fileLinksAsPaths, mergeToolUpdate, toolCall, toolResult } from './tools.ts'
import { checkpointEvery } from '../../shared/checkpoint.ts'

export const agentName = 'Antigravity'
export const Session = defineDoc<Partial<AcpSession>>({
  kind: SessionDoc.kind,
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
export const Turn = defineDoc<LiveTurn>({
  kind: TurnDoc.kind,
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ tools: {}, order: [] }),
})

export const str = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback)
export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

function choices(raw: unknown): ConfigOption['options'] {
  return Array.isArray(raw)
    ? raw.flatMap((entry) => {
        const choice = record(entry)
        if (Array.isArray(choice.options)) return choices(choice.options)
        if (typeof choice.value !== 'string') return []
        return [{ value: choice.value, name: str(choice.name, choice.value) }]
      })
    : []
}

export function configOptions(raw: unknown): ConfigOption[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): ConfigOption[] => {
    const option = record(entry)
    if (option.type !== 'select' || typeof option.id !== 'string') return []
    return [
      {
        id: option.id,
        name: str(option.name, option.id),
        ...(typeof option.category === 'string' ? { category: option.category } : {}),
        value: str(option.currentValue),
        options: choices(option.options),
      },
    ]
  })
}

export async function appendAssistant(
  tx: Tx,
  id: ConversationId,
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'] = 'stop',
  errorMessage?: string,
) {
  const session = await tx.doc(Session, id)
  const selected = session.config?.find((option) => option.category === 'model')
  const model = selected?.options.find((choice) => choice.value === selected.value)?.name
  await tx.appendEntry(id, {
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        content,
        api: 'acp',
        provider: 'acp:antigravity',
        model: model ?? agentName,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason,
        ...(errorMessage === undefined ? {} : { errorMessage }),
        timestamp: Date.now(),
      },
    ],
  })
}

async function settleOpen(tx: Tx, id: ConversationId, turn: LiveTurn) {
  const block = turn.open
  if (!block) return
  delete turn.open
  await appendAssistant(
    tx,
    id,
    block.type === 'thinking'
      ? [{ type: 'thinking', thinking: block.text }]
      : [{ type: 'text', text: fileLinksAsPaths(block.text) }],
  )
}

const callOf = (tool: LiveTool) => tool.call as unknown as ToolCall

async function settleTool(tx: Tx, id: ConversationId, turn: LiveTurn, key: string) {
  const pending = turn.tools[key]
  if (!pending) return
  const call = callOf(pending)
  const ended = pending.status === 'done' || pending.status === 'error'
  const result = toolResult(call, pending.data, pending.status !== 'done')
  if (!ended)
    result.content.push({
      type: 'text',
      text: 'Antigravity ended the turn before this call finished',
    })
  delete turn.tools[key]
  turn.order = turn.order.filter((one) => one !== key)
  await appendAssistant(tx, id, [call], 'toolUse')
  await tx.appendEntry(id, {
    kind: 'pi.tool-result',
    model: [result],
    data: { diagnostics: [] },
  })
}

export async function settleTurn(tx: Tx, id: ConversationId) {
  const turn = await tx.doc(Turn, id)
  await settleOpen(tx, id, turn)
  for (const key of turn.order.slice()) await settleTool(tx, id, turn, key)
}

export async function apply(
  tx: Tx,
  id: ConversationId,
  update: Record<string, unknown>,
  metadata: ExtensionHost['metadata'],
) {
  const session = await tx.doc(Session, id)
  const turn = await tx.doc(Turn, id)
  const kind = update.sessionUpdate
  if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
    const content = record(update.content)
    const chunk = content.type === 'text' ? str(content.text) : ''
    if (!chunk) return
    const type = kind === 'agent_thought_chunk' ? 'thinking' : 'text'
    if (turn.open && turn.open.type !== type) await settleOpen(tx, id, turn)
    turn.open = { type, text: (turn.open?.text ?? '') + chunk }
  } else if (kind === 'tool_call' || kind === 'tool_call_update') {
    if (typeof update.toolCallId !== 'string') return
    await settleOpen(tx, id, turn)
    const key = `tool:${update.toolCallId}`
    const known = turn.tools[key]
    const data = mergeToolUpdate(known?.data, update)
    const call = toolCall(data, agentName)
    const status = str(data.status)
    const done = status === 'completed' || status === 'failed'
    turn.tools[key] = {
      call: call as unknown as JsonObject,
      data,
      status:
        status === 'failed'
          ? 'error'
          : done
            ? 'done'
            : status === 'in_progress'
              ? 'running'
              : 'pending',
    }
    if (!turn.order.includes(key)) turn.order.push(key)
    if (done) await settleTool(tx, id, turn, key)
  } else if (kind === 'plan' && Array.isArray(update.entries)) {
    await settleOpen(tx, id, turn)
    const lines = update.entries.map((entry) => {
      const e = record(entry)
      const mark = e.status === 'completed' ? '[x]' : e.status === 'in_progress' ? '[~]' : '[ ]'
      return `- ${mark} ${str(e.content)}`
    })
    await appendAssistant(tx, id, [{ type: 'thinking', thinking: `Plan\n${lines.join('\n')}` }])
  } else if (
    kind === 'usage_update' &&
    typeof update.used === 'number' &&
    typeof update.size === 'number'
  )
    session.usage = { used: update.used, size: update.size }
  else if (kind === 'session_info_update' && typeof update.title === 'string')
    (await tx.doc(metadata, id)).title = update.title
  else if (kind === 'config_option_update') session.config = configOptions(update.configOptions)
  else if (kind === 'current_mode_update') {
    const mode = session.config?.find((option) => option.category === 'mode')
    if (mode && typeof update.currentModeId === 'string') mode.value = update.currentModeId
  }
}
