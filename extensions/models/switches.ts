import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'

export interface Switch {
  /** `from` and `to` as shown (the id alone when the provider stays), `fromRef` and `toRef` as `provider/id`. */
  model?: { from: string; to: string; fromRef: string; toRef: string }
  thinking?: { from: string; to: string }
}

const responseOf = (entry: EntryRecord): AssistantMessage | undefined => {
  const message = entry.model?.[0]
  return entry.kind === 'pi.assistant' && message?.role === 'assistant' ? message : undefined
}

/**
 * The thinking levels of two responses, when both record one the same way: the level the request asked for, or else
 * the one the provider reports using (responses from before levels were recorded have only the latter, and only for
 * providers that report it).
 */
function levels(before: AssistantMessage, after: AssistantMessage) {
  if (before.thinkingLevel && after.thinkingLevel)
    return { from: before.thinkingLevel, to: after.thinkingLevel }
  if (before.providerThinkingLevel && after.providerThinkingLevel)
    return { from: before.providerThinkingLevel, to: after.providerThinkingLevel }
  return undefined
}

/** What changed since the response before `entry`; undefined for the first loaded response and one that changed nothing. */
export function switchAt(entries: readonly EntryRecord[], entry: EntryRecord): Switch | undefined {
  const response = responseOf(entry)
  if (!response) return undefined
  const leveled = !!(response.thinkingLevel || response.providerThinkingLevel)
  let previous: AssistantMessage | undefined
  let thinking: Switch['thinking']
  for (let index = entries.indexOf(entry) - 1; index >= 0; index--) {
    const message = responseOf(entries[index])
    if (!message) continue
    previous ??= message
    thinking = levels(message, response)
    if (thinking || !leveled) break
  }
  if (!previous) return undefined
  const change: Switch = {}
  if (previous.provider !== response.provider || previous.model !== response.model) {
    const named = (message: AssistantMessage) =>
      previous?.provider === response.provider
        ? message.model
        : `${message.provider}/${message.model}`
    change.model = {
      from: named(previous),
      to: named(response),
      fromRef: `${previous.provider}/${previous.model}`,
      toRef: `${response.provider}/${response.model}`,
    }
  }
  if (thinking && thinking.from !== thinking.to) change.thinking = thinking
  return change.model || change.thinking ? change : undefined
}
