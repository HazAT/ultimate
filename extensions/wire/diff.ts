/**
 * What changed between two request bodies of one conversation, in the order the provider caches them. Anthropic
 * caches tools, then system, then messages, whatever order the JSON lists them in; OpenAI's Responses API caches
 * the prompt from its start: instructions, tools, input. A raw byte diff of the JSON would point at the wrong place.
 */
import type { WireDiff } from './refs.ts'

type Segment = { path: string; json: string }
type Body = Record<string, unknown>

const list = (value: unknown) => (Array.isArray(value) ? (value as unknown[]) : [])

/** Each message is split into its content blocks, so a change points at the block, not the whole message. */
function messageSegments(key: string, messages: unknown): Segment[] {
  return list(messages).flatMap((message, i) => {
    const { content, ...rest } = (message ?? {}) as Body
    const head = { path: `${key}[${i}]`, json: JSON.stringify(rest) }
    if (!Array.isArray(content)) return [{ ...head, json: JSON.stringify(message) }]
    return [
      head,
      ...content.map((block, j) => ({
        path: `${key}[${i}].content[${j}]`,
        json: JSON.stringify(block),
      })),
    ]
  })
}

const entries = (key: string, value: unknown): Segment[] =>
  value === undefined
    ? []
    : Array.isArray(value)
      ? value.map((item, i) => ({ path: `${key}[${i}]`, json: JSON.stringify(item) }))
      : [{ path: key, json: JSON.stringify(value) }]

/** The cacheable prefix of `body` as segments in cache order, and the remaining settings by key. */
export function segments(body: Body): { prefix: Segment[]; settings: Body } {
  const { tools, system, messages, instructions, input, ...settings } = body
  if (messages !== undefined)
    return {
      prefix: [
        ...entries('tools', tools),
        ...entries('system', system),
        ...messageSegments('messages', messages),
      ],
      settings,
    }
  return {
    prefix: [
      ...entries('instructions', instructions),
      ...entries('tools', tools),
      ...messageSegments('input', input),
    ],
    settings,
  }
}

const CONTEXT = 160

/** The first segment where `current` departs from `previous`, the segments it added after that, and changed settings. */
export function diffBodies(previous: Body, current: Body, previousN: number): WireDiff {
  const before = segments(previous)
  const after = segments(current)
  let same = 0
  while (
    same < before.prefix.length &&
    same < after.prefix.length &&
    before.prefix[same].json === after.prefix[same].json
  )
    same += 1
  const prefixBytes = after.prefix
    .slice(0, same)
    .reduce((sum, segment) => sum + segment.json.length, 0)
  const settings = [...new Set([...Object.keys(before.settings), ...Object.keys(after.settings)])]
    .filter((key) => JSON.stringify(before.settings[key]) !== JSON.stringify(after.settings[key]))
    .map((key) => ({
      key,
      ...(key in before.settings ? { before: JSON.stringify(before.settings[key]) } : {}),
      ...(key in after.settings ? { after: JSON.stringify(after.settings[key]) } : {}),
    }))
  const diff: WireDiff = {
    previous: previousN,
    segments: after.prefix.length,
    same,
    prefixBytes,
    added: after.prefix.slice(same).map(({ path, json }) => ({ path, json })),
    removed: before.prefix.slice(same).map((segment) => segment.path),
    settings,
  }
  // Only a segment present on both sides that changed is a break inside the prefix; a pure append is the cache working.
  const old = before.prefix[same]
  const now = after.prefix[same]
  if (old && now) {
    let offset = 0
    while (offset < old.json.length && old.json[offset] === now.json[offset]) offset += 1
    diff.firstChange = {
      path: now.path,
      offset,
      lead: now.json.slice(Math.max(0, offset - CONTEXT), offset),
      before: old.json.slice(offset, offset + CONTEXT),
      after: now.json.slice(offset, offset + CONTEXT),
    }
  }
  return diff
}
