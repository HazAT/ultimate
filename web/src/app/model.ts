import type { AssistantMessage, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai'
import type { EntryRecord, LiveState, ToolDiagnostic, ToolSlot } from '@earendil-works/pi-durable'
import type { ToolCallView } from '../sdk/types.ts'

export interface ToolResult {
  message: ToolResultMessage
  diagnostics: readonly ToolDiagnostic[]
}

/** Tool results by call id, and the ids of calls some assistant entry made. */
export function indexTools(entries: readonly EntryRecord[]) {
  const results = new Map<string, ToolResult>()
  const calls = new Set<string>()
  for (const entry of entries) {
    const message = entry.model?.[0]
    if (entry.kind === 'pi.tool-result' && message?.role === 'toolResult') {
      const data = entry.data as { diagnostics?: ToolDiagnostic[] } | undefined
      results.set(message.toolCallId, {
        message,
        diagnostics: data?.diagnostics ?? [],
      })
    }
    if (entry.kind === 'pi.assistant' && message?.role === 'assistant')
      for (const block of message.content) if (block.type === 'toolCall') calls.add(block.id)
  }
  return { results, calls }
}

export function slotsOf(tools: LiveState['tools']): Map<string, ToolSlot> {
  return new Map((tools ?? []).map((slot) => [slot.callId, slot]))
}

// Pi upstream: @earendil-works/pi-durable@1.5.0 src/harness/tool.ts — internal trailing <harness> text block duplicates diagnostics and is stripped for display. Drop when Pi exports a diagnostic-free tool-result content accessor.
/** The result's text, without the `<harness>` block that repeats its diagnostics for the model. */
export function resultText(result: ToolResult): string {
  const texts = result.message.content.flatMap((block) =>
    block.type === 'text' ? [block.text] : [],
  )
  if (result.diagnostics.length > 0 && texts.at(-1)?.startsWith('<harness>')) texts.pop()
  return texts.join('')
}

/** When the calls of an answer start: once its response ended (legacy answers without a duration: when it was asked). */
export function callsStart(message: AssistantMessage): number {
  return message.timestamp + (message.durationMs ?? 0)
}

/**
 * A tool call's view, timed from durable timestamps so a call first seen mid-run shows how long it really ran:
 * `startedAt` is `callsStart` of the call's answer, used while it runs and for results without their own duration.
 */
export function toolCallView(
  call: ToolCall,
  context: {
    result?: ToolResult
    slot?: ToolSlot
    streaming: boolean
    busy: boolean
    startedAt?: number
  },
): ToolCallView {
  const { result, slot, streaming, busy } = context
  let status: ToolCallView['status']
  if (result) status = result.message.isError ? 'error' : 'done'
  else if (slot) status = slot.status === 'done' ? 'interrupted' : slot.status
  else if (streaming) status = 'streaming'
  else status = busy ? 'pending' : 'interrupted'

  // Finished: the result's own timestamp and duration. Live: since its answer ended. Interrupted: no times.
  const endedAt = result?.message.timestamp
  const startedAt = result
    ? result.message.durationMs === undefined
      ? context.startedAt
      : result.message.timestamp - result.message.durationMs
    : status === 'pending' || status === 'running'
      ? context.startedAt
      : undefined

  return {
    id: call.id,
    name: call.name,
    args: call.arguments ?? {},
    status,
    output: result ? resultText(result) : (slot?.output ?? ''),
    images: result?.message.content.filter((block) => block.type === 'image') ?? [],
    details: result ? result.message.details : slot?.details,
    diagnostics: result?.diagnostics ?? slot?.diagnostics ?? [],
    ...(slot?.droppedBytes
      ? { dropped: { bytes: slot.droppedBytes, lines: slot.droppedLines ?? 0 } }
      : {}),
    startedAt,
    endedAt: startedAt === undefined ? undefined : endedAt,
    result: result?.message,
  }
}

/** The streaming partial of the current generation, if any. */
export function partialOf(live: LiveState): AssistantMessage | undefined {
  return live.generation?.message
}
