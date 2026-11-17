import type { AssistantMessage, Message, Tool, Usage } from '@earendil-works/pi-ai'
import { estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate'
import type { EntryRecord } from '@earendil-works/pi-durable'

export const promptTokens = (usage: Pick<Usage, 'input' | 'cacheRead' | 'cacheWrite'>) =>
  usage.input + usage.cacheRead + usage.cacheWrite

export interface CacheBust {
  written: number
  read: number
  before: number
  gap: number
  cause: 'system' | 'model' | 'expired' | 'prefix'
  system?: number
}

const minimumFreshTokensForCacheBust = 5000

export function cacheBusts(entries: readonly EntryRecord[]): Map<number, CacheBust> {
  const known = cacheBustsByTranscript.get(entries)
  if (known) return known
  const busts = new Map<number, CacheBust>()
  let previous: AssistantMessage | undefined
  let system: number | undefined
  for (const entry of entries) {
    const rebuildsOnPurpose = entry.kind === 'pi.compaction' || entry.kind === 'pi.reset'
    if (rebuildsOnPurpose) previous = undefined
    if (entry.kind === 'pi.system') system = entry.id
    const message = entry.model?.[0]
    if (entry.kind !== 'pi.assistant' || message?.role !== 'assistant') continue
    const { usage } = message
    if (promptTokens(usage) === 0) continue
    if (previous) {
      const before = promptTokens(previous.usage)
      const written = usage.input + usage.cacheWrite
      if (usage.cacheRead < before / 2 && written >= minimumFreshTokensForCacheBust) {
        const gapMs = message.timestamp - previous.timestamp
        const oneHourCacheMs = 3600_000
        const defaultProviderCacheMs = 300_000
        const cacheTtlMs =
          (previous.usage.cacheWrite1h ?? 0) > 0 ? oneHourCacheMs : defaultProviderCacheMs
        const cause =
          system !== undefined
            ? 'system'
            : `${previous.provider}/${previous.model}` !== `${message.provider}/${message.model}`
              ? 'model'
              : gapMs > cacheTtlMs
                ? 'expired'
                : 'prefix'
        busts.set(entry.id, {
          written,
          read: usage.cacheRead,
          before,
          gap: gapMs,
          cause,
          ...(system !== undefined && { system }),
        })
      }
    }
    previous = message
    system = undefined
  }
  cacheBustsByTranscript.set(entries, busts)
  return busts
}

const cacheBustsByTranscript = new WeakMap<readonly EntryRecord[], Map<number, CacheBust>>()

export function contextUsage(
  { tokens, window, estimated }: { tokens?: number; window?: number; estimated?: boolean },
  at: number,
) {
  return {
    ...(tokens === undefined ? {} : { tokens }),
    ...(window === undefined ? {} : { window }),
    ...(tokens === undefined || !window ? {} : { percent: (tokens / window) * 100 }),
    ...(estimated === undefined ? {} : { estimated }),
    at,
  }
}

export function lastAssistant(entries: readonly EntryRecord[]) {
  let marker: EntryRecord | undefined
  let message: AssistantMessage | undefined
  let latestAssistantEntryId = -1
  for (const entry of entries) {
    if (entry.kind === 'pi.compaction' || entry.kind === 'pi.reset') {
      if (!marker || entry.id > marker.id) marker = entry
    }
    const model = entry.model?.[0]
    if (
      entry.kind === 'pi.assistant' &&
      model?.role === 'assistant' &&
      entry.id > latestAssistantEntryId
    ) {
      message = model
      latestAssistantEntryId = entry.id
    }
  }
  if (marker && latestAssistantEntryId < marker.id) return { stale: true, marker: marker.id }
  return message ? { message, stale: false } : { stale: false }
}

export function estimateAfterHead(previous: readonly Message[], current: readonly Message[]) {
  let previousSystemBaseline: Extract<Message, { role: 'system' }>['content'] | undefined
  const sections = new Map<string, string>()
  const tools = new Map<string, Tool>()
  for (const message of previous) {
    if (message.role !== 'system') continue
    previousSystemBaseline ??= message.content
    for (const [name, text] of Object.entries(message.sections ?? {}))
      if (text === null) sections.delete(name)
      else sections.set(name, text)
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name)
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool)
  }
  const system = estimateMessageTokens({
    role: 'system',
    content: previousSystemBaseline ?? '',
    sections: Object.fromEntries(sections),
    toolsAdded: [...tools.values()],
    timestamp: 0,
  })
  const nonSystemMessages = current.filter((message) => message.role !== 'system')
  return nonSystemMessages.reduce((sum, message) => sum + estimateMessageTokens(message), system)
}
