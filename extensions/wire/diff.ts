import type { WireDiff } from './refs.ts'

type Segment = { path: string; json: string }
type Body = Record<string, unknown>

const jsonWithoutMovingCacheMarkers = (json: string) =>
  JSON.stringify(
    JSON.parse(json, (key, value: unknown) => (key === 'cache_control' ? undefined : value)),
  )

const list = (value: unknown) => (Array.isArray(value) ? (value as unknown[]) : [])

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

export function segments(body: Body): { prefix: Segment[]; settings: Body } {
  const { tools, system, messages, instructions, input, ...settings } = body
  if (messages !== undefined) {
    const anthropicCacheOrder = [
      ...entries('tools', tools),
      ...entries('system', system),
      ...messageSegments('messages', messages),
    ]
    return { prefix: anthropicCacheOrder, settings }
  }
  const responsesCacheOrder = [
    ...entries('instructions', instructions),
    ...entries('tools', tools),
    ...messageSegments('input', input),
  ]
  return { prefix: responsesCacheOrder, settings }
}

const CHANGE_CONTEXT_CHARACTERS = 160

export function diffBodies(previous: Body, current: Body, previousN: number): WireDiff {
  const before = segments(previous)
  const after = segments(current)
  let same = 0
  while (
    same < before.prefix.length &&
    same < after.prefix.length &&
    jsonWithoutMovingCacheMarkers(before.prefix[same].json) ===
      jsonWithoutMovingCacheMarkers(after.prefix[same].json)
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
  const old = before.prefix[same]
  const now = after.prefix[same]
  const changedSegmentExistsOnBothSides = old && now
  if (changedSegmentExistsOnBothSides) {
    const was = jsonWithoutMovingCacheMarkers(old.json)
    const is = jsonWithoutMovingCacheMarkers(now.json)
    let offset = 0
    while (offset < was.length && was[offset] === is[offset]) offset += 1
    diff.firstChange = {
      path: now.path,
      offset,
      lead: is.slice(Math.max(0, offset - CHANGE_CONTEXT_CHARACTERS), offset),
      before: was.slice(offset, offset + CHANGE_CONTEXT_CHARACTERS),
      after: is.slice(offset, offset + CHANGE_CONTEXT_CHARACTERS),
    }
  }
  return diff
}
