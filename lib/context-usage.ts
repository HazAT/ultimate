import type { AssistantMessage, Message, Tool, Usage } from '@earendil-works/pi-ai'
import { estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate'
import type { EntryRecord } from '@earendil-works/pi-durable'

/** What a response's prompt took: the context it was sent with. */
export const promptTokens = (usage: Pick<Usage, 'input' | 'cacheRead' | 'cacheWrite'>) =>
  usage.input + usage.cacheRead + usage.cacheWrite

/**
 * A response that rebuilt the prompt cache: it read under half of the previous response's prompt from the cache and
 * sent at least 5k tokens fresh (written to the cache, or uncached where a provider reports no writes). `cause` is
 * what came between: a system prompt change (`system`, that `pi.system` entry's ID), a model switch, a gap longer than
 * the cache lives (`expired`), or else an earlier part of the context that changed (`prefix`).
 */
export interface CacheBust {
  written: number
  read: number
  /** The previous response's prompt. */
  before: number
  /** Milliseconds since the previous response. */
  gap: number
  cause: 'system' | 'model' | 'expired' | 'prefix'
  system?: number
}

const FRESH = 5000

/**
 * The cache rebuilds in `entries`, by the ID of the `pi.assistant` entry that paid for them. A compaction or reset
 * rebuilds on purpose and shows its own card, so a rebuild right after one is left out.
 */
export function cacheBusts(entries: readonly EntryRecord[]): Map<number, CacheBust> {
  const known = found.get(entries)
  if (known) return known
  const busts = new Map<number, CacheBust>()
  let previous: AssistantMessage | undefined
  let system: number | undefined
  for (const entry of entries) {
    if (entry.kind === 'pi.compaction' || entry.kind === 'pi.reset') previous = undefined
    if (entry.kind === 'pi.system') system = entry.id
    const message = entry.model?.[0]
    if (entry.kind !== 'pi.assistant' || message?.role !== 'assistant') continue
    const { usage } = message
    if (promptTokens(usage) === 0) continue
    if (previous) {
      const before = promptTokens(previous.usage)
      const written = usage.input + usage.cacheWrite
      if (usage.cacheRead < before / 2 && written >= FRESH) {
        const gap = message.timestamp - previous.timestamp
        // Claude Code writes the 1-hour cache; other providers keep about five minutes.
        const ttl = (previous.usage.cacheWrite1h ?? 0) > 0 ? 3600_000 : 300_000
        const cause =
          system !== undefined
            ? 'system'
            : `${previous.provider}/${previous.model}` !== `${message.provider}/${message.model}`
              ? 'model'
              : gap > ttl
                ? 'expired'
                : 'prefix'
        busts.set(entry.id, {
          written,
          read: usage.cacheRead,
          before,
          gap,
          cause,
          ...(system !== undefined && { system }),
        })
      }
    }
    previous = message
    system = undefined
  }
  found.set(entries, busts)
  return busts
}

/** One scan per transcript array: every folded line and marker of a transcript asks for the same one. */
const found = new WeakMap<readonly EntryRecord[], Map<number, CacheBust>>()

/** Context fill; absent tokens or window leave the percentage unknown. */
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

/**
 * The latest answer. After a compaction or reset (`marker`) the measured context size is `stale` until a newer
 * response; without either, an empty context. A compaction's view lists its marker before the kept entries, so entry
 * IDs, not positions, tell which came last.
 */
export function lastAssistant(entries: readonly EntryRecord[]) {
  let marker: EntryRecord | undefined
  let message: AssistantMessage | undefined
  let answered = -1
  for (const entry of entries) {
    if (entry.kind === 'pi.compaction' || entry.kind === 'pi.reset') {
      if (!marker || entry.id > marker.id) marker = entry
    }
    const model = entry.model?.[0]
    if (entry.kind === 'pi.assistant' && model?.role === 'assistant' && entry.id > answered) {
      message = model
      answered = entry.id
    }
  }
  if (marker && answered < marker.id) return { stale: true, marker: marker.id }
  return message ? { message, stale: false } : { stale: false }
}

/**
 * Estimated tokens of the next request after a compaction or reset, before a response measures it: the system prompt
 * and tools in effect at the end of the `previous` context, replayed from its system messages, plus the `current`
 * context's other messages (the summary or handoff and the kept entries). Generation writes a fresh baseline after a
 * head marker, so system messages kept in `current` do not count twice.
 */
export function estimateAfterHead(previous: readonly Message[], current: readonly Message[]) {
  let base: Extract<Message, { role: 'system' }>['content'] | undefined
  const sections = new Map<string, string>()
  const tools = new Map<string, Tool>()
  for (const message of previous) {
    if (message.role !== 'system') continue
    base ??= message.content
    for (const [name, text] of Object.entries(message.sections ?? {}))
      if (text === null) sections.delete(name)
      else sections.set(name, text)
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name)
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool)
  }
  const system = estimateMessageTokens({
    role: 'system',
    content: base ?? '',
    sections: Object.fromEntries(sections),
    toolsAdded: [...tools.values()],
    timestamp: 0,
  })
  return current
    .filter((message) => message.role !== 'system')
    .reduce((sum, message) => sum + estimateMessageTokens(message), system)
}
