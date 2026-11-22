import type { ConversationId, Cursor, Tx } from '@earendil-works/pi-durable'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { Memory, Roots } from './api.ts'
import type { MemoryItem } from './refs.ts'

export const MEMORY_LIMIT = 150
export const MEMORY_SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/
const KINDS = ['decision', 'fact', 'lesson'] as const
export const LINE_CHARS = 120
export const BODY_CHARS = 2000

export const MEMORY_RULES = `slug kebab-case, matching ${MEMORY_SLUG.source} (at most 48 characters); line a single line of at most ${LINE_CHARS} characters; body at most ${BODY_CHARS} characters; at most ${MEMORY_LIMIT} memories per root`

export type MemoryOp =
  | {
      op: 'add'
      slug: string
      kind: MemoryItem['kind']
      line: string
      body: string
      source?: string
    }
  | {
      op: 'update'
      slug: string
      kind?: MemoryItem['kind']
      line?: string
      body?: string
      source?: string
    }
  | { op: 'delete'; slug: string }

function parseOp(value: unknown, index: number): MemoryOp {
  const fail = (why: string): never => {
    throw new Error(`Op ${index + 1}: ${why}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('expected an object')
  const { op, slug, kind, line, body, source } = value as Record<string, unknown>
  if (op !== 'add' && op !== 'update' && op !== 'delete')
    return fail('op must be add, update or delete')
  if (typeof slug !== 'string' || !MEMORY_SLUG.test(slug))
    return fail(`slug must match ${MEMORY_SLUG.source}, got ${JSON.stringify(slug)}`)
  if (op === 'delete') return { op, slug }
  const fields: { kind?: MemoryItem['kind']; line?: string; body?: string; source?: string } = {}
  if (kind !== undefined) {
    if (!KINDS.includes(kind as MemoryItem['kind']))
      return fail('kind must be decision, fact or lesson')
    fields.kind = kind as MemoryItem['kind']
  }
  if (line !== undefined) {
    if (typeof line !== 'string' || !line.trim() || /\n/.test(line.trim()))
      return fail('line must be one non-empty line')
    if (line.trim().length > LINE_CHARS)
      return fail(
        `line is ${line.trim().length} characters; it must be at most ${LINE_CHARS}: shorten it and move detail into the body`,
      )
    fields.line = line.trim()
  }
  if (body !== undefined) {
    if (typeof body !== 'string' || !body.trim()) return fail('body must be non-empty text')
    if (body.trim().length > BODY_CHARS)
      return fail(
        `body is ${body.trim().length} characters; it must be at most ${BODY_CHARS}: shorten it or split it across memories`,
      )
    fields.body = body.trim()
  }
  if (source !== undefined) {
    if (typeof source !== 'string' || !/^#\d+(\/\d+)?$/.test(source))
      return fail('source must be #<conversation>/<entry>')
    fields.source = source
  }
  if (op === 'update') {
    if (!Object.keys(fields).length) return fail('update changes nothing')
    return { op, slug, ...fields }
  }
  if (!fields.kind || !fields.line || !fields.body) return fail('add needs kind, line and body')
  return { op, slug, kind: fields.kind, line: fields.line, body: fields.body, ...fields }
}

export async function applyMemoryOps(
  tx: Tx,
  root: ConversationId,
  ops: readonly unknown[],
  now = Date.now(),
) {
  if (!(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots.includes(root))
    throw new Error(`#${root} is not a listed root`)
  if (!Array.isArray(ops)) throw new Error('ops must be a list')
  const parsed = ops.map(parseOp)
  const doc = await tx.doc(Memory, root)
  const validatedBatchBeforeAnyWrite = new Map(Object.entries(doc.memories))
  const done: Record<MemoryOp['op'], string[]> = { add: [], update: [], delete: [] }
  for (const [index, op] of parsed.entries()) {
    const current = validatedBatchBeforeAnyWrite.get(op.slug)
    if (op.op === 'add') {
      if (current) throw new Error(`Op ${index + 1}: ${op.slug} exists; update it instead`)
      const { slug: _, op: __, ...item } = op
      validatedBatchBeforeAnyWrite.set(op.slug, { ...item, updated: now })
    } else if (!current) throw new Error(`Op ${index + 1}: no memory ${op.slug}`)
    else if (op.op === 'delete') validatedBatchBeforeAnyWrite.delete(op.slug)
    else {
      const { slug: _, op: __, ...fields } = op
      validatedBatchBeforeAnyWrite.set(op.slug, { ...current, ...fields, updated: now })
    }
    done[op.op].push(op.slug)
  }
  if (validatedBatchBeforeAnyWrite.size > MEMORY_LIMIT)
    throw new Error(
      `${validatedBatchBeforeAnyWrite.size} memories exceed the limit of ${MEMORY_LIMIT}; merge or delete some instead of adding`,
    )
  if (!parsed.length) return 'No changes.'
  for (const slug of Object.keys(doc.memories))
    if (!validatedBatchBeforeAnyWrite.has(slug)) delete doc.memories[slug]
  for (const [slug, item] of validatedBatchBeforeAnyWrite)
    if (JSON.stringify(doc.memories[slug]) !== JSON.stringify(item)) doc.memories[slug] = item
  return `${[...said('Added', done.add), ...said('updated', done.update), ...said('deleted', done.delete)].join('; ')} in #${root}'s memory.`
}

const said = (verb: string, slugs: string[]) =>
  slugs.length ? [`${verb} ${[...new Set(slugs)].join(', ')}`] : []

const day = (at: number) => new Date(at).toISOString().slice(0, 10)

export function memoryIndex(memories: Record<string, MemoryItem>) {
  return Object.keys(memories)
    .toSorted()
    .map((slug) => {
      const { kind, line, updated } = memories[slug]
      return `${slug} [${kind}] — ${line} (updated ${day(updated)})`
    })
}

export function memoryText(slug: string, item: MemoryItem) {
  return [
    `${slug} [${item.kind}] — ${item.line} (updated ${day(item.updated)})`,
    ...(item.source ? [`Source: ${item.source}`] : []),
    '',
    item.body,
  ].join('\n')
}

async function recentLandingsBeforeTableWrites(tx: Tx, root: ConversationId, limit: number) {
  const lines: string[] = []
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanEntries({ conversationId: root }, 100, cursor)
    for (const entry of page.items) {
      const data = (entry.data ?? {}) as Record<string, unknown>
      if (entry.kind !== 'lineage.note' || data.source !== 'lander' || typeof data.sha !== 'string')
        continue
      const name = [data.feature, data.title].filter((part) => typeof part === 'string' && part)
      lines.push(
        `- ${data.sha.slice(0, 7)} ${name.join(': ') || 'landing'}${typeof data.from === 'number' ? ` (#${data.from})` : ''}`,
      )
      if (lines.length === limit) return lines
    }
    cursor = page.next
  } while (cursor)
  return lines
}

export async function memoryBrief(tx: Tx, root: ConversationId) {
  const { memories } = await tx.doc(Memory, root)
  if (!Object.keys(memories).length) return undefined
  const landings = await recentLandingsBeforeTableWrites(tx, root, 10)
  const text = [
    `<project_memory root="#${root}">`,
    ...memoryIndex(memories),
    '</project_memory>',
    ...(landings.length ? ['Recent landings (newest first):', ...landings] : []),
    `The full project context (every branch, abstract and landing) is root #${root}: read it with codemode \`ultimate.entries(${root})\` or \`ultimate.search(text)\`; read a memory with \`memory {read: slug}\`; \`git log\` has the commits.`,
  ].join('\n')
  return { text }
}
