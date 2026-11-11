import { resolve } from 'node:path'
import { parseSync } from 'vite-plus'
import { expect, it } from 'vitest'
import ultimate from '../lint/ultimate.ts'

type Rule = keyof typeof ultimate.rules
type Located = { type: string; start: number; end: number; parent?: Located }
type Comment = { type: string; value: string; start: number; end: number }

/** Run one rule over `source` as oxlint would for `file` (repository-relative): parse, walk, report messages. */
function lint(rule: Rule, file: string, source: string) {
  const { program, comments } = parseSync(file, source, { lang: 'ts' }) as unknown as {
    program: Located
    comments: Comment[]
  }
  const reports: string[] = []
  // The comments right before a node, with only whitespace between them and it.
  const getCommentsBefore = (node: Located) => {
    const found: Comment[] = []
    let at = node.start
    for (const comment of comments.toReversed()) {
      if (comment.end > at) continue
      if (source.slice(comment.end, at).trim()) break
      found.unshift(comment)
      at = comment.start
    }
    return found
  }
  const visitors = ultimate.rules[rule].create({
    filename: resolve(file),
    options: [],
    sourceCode: { text: source, getCommentsBefore, getCommentsInside: () => [] },
    report: ({ message }) => reports.push(message),
  }) as Record<string, ((node: Located) => void) | undefined>
  const visit = (node: Located, parent?: Located) => {
    node.parent = parent
    visitors[node.type]?.(node)
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent') continue
      for (const child of Array.isArray(value) ? value : [value])
        if (child && typeof child === 'object' && typeof child.type === 'string')
          visit(child as Located, node)
    }
  }
  visit(program)
  return reports
}

const api = `/**
 * Echo: says things back. Other extensions ask it to repeat text.
 */
import type { Context } from '@earendil-works/chord/context'
import { defineDoc } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import type { Message } from '../messages/api.ts'
import { Messages } from '../messages/api.ts'
import type { echo } from './server.ts'

type Helper = ReturnType<typeof echo>

export type EchoService = {
  /** Repeat \`text\`; use it to test a round trip. */
  echo(text: string, ctx: Context): Promise<string>
  /** The last message echoed. */
  last: () => Message | undefined
}
/** The echo service; \`want\` it. */
export const EchoApi = defineApi<EchoService>()('echo')
export { Repeated } from './refs.ts'
/** The echo log. */
export const Log = defineDoc<{ texts: string[] }>({ kind: 'echo.log', checkpointWhen: () => false, version: 1, scope: 'conversation', initial: () => ({ texts: [] }) })
`

it('accepts an api.ts of documented contracts and rejects runtime code, node imports and missing docs', () => {
  expect(lint('api-file-shape', 'extensions/echo/api.ts', api)).toEqual([])
  expect(lint('api-naming', 'extensions/echo/api.ts', api)).toEqual([])
  // Only api.ts files are checked.
  expect(lint('api-file-shape', 'extensions/echo/server.ts', 'const x = 1')).toEqual([])

  const bad = `import { readFile } from 'node:fs/promises'
import { echo } from './server.ts'
import { Messages } from '../messages/server.ts'
import { defineApi } from '../../shared/extension-api.ts'
export interface EchoService {
  echo(text: string): string
  /** Documented. */
  last(): string
}
export const EchoApi = defineApi<EchoService>()('echo')
export const limit = 3
export function helper() {}
/** An event belongs in refs.ts. */
export const Echoed = defineEvent<{ text: string }>('echo.echoed')
export { EchoLine } from './line.ts'
`
  expect(lint('api-file-shape', 'extensions/echo/api.ts', bad)).toEqual([
    'Start api.ts with a doc comment on what it offers; its first sentence is the one-line summary.',
    'api.ts is a contract: it imports no node:* module.',
    "api.ts imports at runtime only shared/, packages, its refs.ts and other extensions' api.ts; use `import type` for the rest.",
    "api.ts imports at runtime only shared/, packages, its refs.ts and other extensions' api.ts; use `import type` for the rest.",
    'Document each exported token: what it is and when to use it.',
    ...Array(4).fill(
      "api.ts holds only contracts: imports, `export const X = defineApi/defineDoc/defineEntry(...)`, re-exports of its refs.ts (where event tokens live, for the browser too), types and `export const tier = 'core'`.",
    ),
    'Document EchoService.echo: what it does and when to call it.',
  ])
  // The tier line joins the core tier; any other tier is rejected.
  expect(
    lint('api-file-shape', 'extensions/echo/api.ts', `${api}export const tier = 'core'\n`),
  ).toEqual([])
  expect(
    lint('api-file-shape', 'extensions/echo/api.ts', `${api}export const tier = 'optional'\n`),
  ).toEqual(["An extension declares its tier as `export const tier = 'core'` or not at all."])
  // A header without a sentence is no summary.
  expect(
    lint(
      'api-file-shape',
      'extensions/echo/api.ts',
      `/** Echo */\n${api.slice(api.indexOf('import'))}`,
    ),
  ).toContain(
    'Start api.ts with a doc comment on what it offers; its first sentence is the one-line summary.',
  )
})

const refs = `/**
 * Echo in the browser: the echo log and the action that echoes. Browser-safe.
 */
import type { JsonValue } from '@earendil-works/chord/json'
import { actionRef, docRef } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'
import type { ProviderHealth } from '../../shared/protocol.ts'
import type { MessagesData } from '../messages/refs.ts'
import type { EchoRow } from './types.ts'

type Texts = { texts: string[] }
export type Echoed = { text: string; at: number }

/** The echo log on conversation 1. */
export const LogDoc = docRef<Texts>('echo.log')
/** \`{ text }\` → what was echoed. */
export const EchoAction = actionRef<{ text: string }, Echoed>('echo', 'echo')
/** Something was echoed; react to it to count echoes. */
export const Repeated = defineEvent<{ text: string }>('echo.repeated')
`

it('accepts a refs.ts of documented browser-safe refs and rejects server reach, runtime code and missing docs', () => {
  expect(lint('api-file-shape', 'extensions/echo/refs.ts', refs)).toEqual([])
  expect(lint('api-naming', 'extensions/echo/refs.ts', refs)).toEqual([])

  const bad = `/** Echo in the browser. */
import { readFile } from 'node:fs/promises'
import { EchoApi } from './api.ts'
import { defineDoc } from '@earendil-works/pi-durable'
import type { echo } from './server.ts'
import type { git } from '../../lib/git.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { MessagesService } from '../messages/api.ts'
import { docRef } from '../../shared/extension-api.ts'
export const LogDoc = docRef<{ texts: string[] }>('echo.log')
export const limit = 3
`
  expect(lint('api-file-shape', 'extensions/echo/refs.ts', bad)).toEqual([
    'refs.ts is a contract: it imports no node:* module.',
    'refs.ts imports at runtime only shared/; use `import type` for the rest.',
    'refs.ts imports at runtime only shared/; use `import type` for the rest.',
    "refs.ts is browser-safe: it imports types only from packages, shared/ and extensions' refs.ts or types.ts.",
    "refs.ts is browser-safe: it imports types only from packages, shared/ and extensions' refs.ts or types.ts.",
    "refs.ts is browser-safe: it imports types only from packages, shared/ and extensions' refs.ts or types.ts.",
    "refs.ts is browser-safe: it imports types only from packages, shared/ and extensions' refs.ts or types.ts.",
    "Document each ref: what it holds, or an action's arguments and result.",
    'refs.ts holds only contracts: imports, `export const X = docRef/actionRef/defineEvent(...)` and types.',
  ])
  expect(
    lint('api-naming', 'extensions/echo/refs.ts', "export const A = actionRef('messages', 'send')"),
  ).toEqual(["extensions/echo refers only to its own actions: actionRef('echo', name)."])
})

it('asks ui.tsx for a summary and nothing else', () => {
  expect(
    lint(
      'api-file-shape',
      'extensions/echo/ui.tsx',
      "/** Echo's components for other extensions: the echo line. */\nexport { EchoLine } from './line.tsx'\nexport const x = 1\n",
    ),
  ).toEqual([])
  expect(
    lint('api-file-shape', 'extensions/echo/ui.tsx', "export { EchoLine } from './line.tsx'"),
  ).toEqual([
    'Start ui.tsx with a doc comment on what it offers; its first sentence is the one-line summary.',
  ])
})

it('names an API after its folder, its extension points and events with its prefix', () => {
  const source = `export const A = defineApi<S>()('other')
export const B = defineEvent('other.thing')
export const C = defineEvent('echo.')
export const D = defineEvent('echo.thing')
export const E = defineApi<S>()('echo.hook')
export const F = defineApi<S>()('other.hook')
export const G = defineApi<S>()('echo.')`
  expect(lint('api-naming', 'extensions/echo/api.ts', source)).toEqual([
    "The API of extensions/echo is named 'echo', its extension points 'echo.<point>'.",
    "Events of extensions/echo are named 'echo.<event>'.",
    "Events of extensions/echo are named 'echo.<event>'.",
    "The API of extensions/echo is named 'echo', its extension points 'echo.<point>'.",
    "The API of extensions/echo is named 'echo', its extension points 'echo.<point>'.",
  ])
})

it('keeps only the existing persisted event names for messages', () => {
  const source = `export const B = defineEvent('board.sent')
export const D = defineEvent('board.new')`
  expect(lint('api-naming', 'extensions/messages/refs.ts', source)).toEqual([
    "Events of extensions/messages are named 'messages.<event>'.",
  ])
  expect(lint('api-naming', 'extensions/echo/refs.ts', source)).toHaveLength(2)
})

it("allows another extension's api.ts and type imports, and rejects its other runtime files", () => {
  const source = `import { MessagesApi } from '../messages/api.ts'
import type { MessagesService } from '../messages/server.ts'
import { git } from '../../lib/git.ts'
import { helper } from './helper.ts'
import { Messages } from '../messages/server.ts'
import { type Standing } from '../subagents/server.ts'
export { roots } from '../lineage/roots.ts'
const later = () => import('../questions/server.ts')`
  expect(lint('api-only-imports', 'extensions/echo/server.ts', source)).toEqual([
    'echo imports messages/server.ts at runtime; reach messages through its api.ts (a service, document or event token), import types with `import type`, or move a pure helper to lib/.',
    'echo imports subagents/server.ts at runtime; reach subagents through its api.ts (a service, document or event token), import types with `import type`, or move a pure helper to lib/.',
    'echo imports lineage/roots.ts at runtime; reach lineage through its api.ts (a service, document or event token), import types with `import type`, or move a pure helper to lib/.',
    'echo imports questions/server.ts at runtime; reach questions through its api.ts (a service, document or event token), import types with `import type`, or move a pure helper to lib/.',
  ])
  // Outside extensions/ nothing is checked.
  expect(lint('api-only-imports', 'test/example.test.ts', source)).toEqual([])
})

const browserMessage = (file: string) =>
  `echo imports ${file} at runtime; reach ${file.split('/')[0]} through its ui.tsx (components, hooks and the refs of its documents and actions), import types with \`import type\`, or move a pure helper to lib/.`

it("allows browser code another extension's ui.tsx at runtime and its api.ts or refs.ts only for types", () => {
  const source = `import { ConversationRef, OverviewDoc } from '../conversations/ui.tsx'
import type { WorkspaceService } from '../workspaces/api.ts'
import type { MessagesData } from '../messages/refs.ts'
import type { Plan } from '../plan/web.tsx'
import { LogDoc } from './refs.ts'
import { useWorkspaces } from '../workspaces/data.tsx'
import { WorkspacesApi } from '../workspaces/api.ts'
import { MessagesDoc } from '../messages/refs.ts'
export { TaskChip } from '../plan/chip.tsx'`
  expect(lint('api-only-imports', 'extensions/echo/web.tsx', source)).toEqual([
    browserMessage('workspaces/data.tsx'),
    browserMessage('workspaces/api.ts'),
    browserMessage('messages/refs.ts'),
    browserMessage('plan/chip.tsx'),
  ])
})

const coreMessage = (optional: string) =>
  `conversations is core tier and imports optional ${optional}; declare a point in conversations that ${optional} provides, or react to an event.`

it('keeps a core-tier extension to core-tier imports, runtime and type alike, and leaves optional ones free', () => {
  // The tiers come from the repository's api.ts files: conversations, lineage and messages are core; phase and plan not.
  const source = `import { LineageApi } from '../lineage/api.ts'
import type { MessagesData } from '../messages/refs.ts'
import { usePhase } from '../phase/ui.tsx'
import type { TaskLink } from '../plan/refs.ts'
export { TaskChip } from '../plan/ui.tsx'
import { git } from '../../lib/git.ts'
const later = () => import('../questions/web.tsx')`
  expect(lint('core-tier-deps', 'extensions/conversations/rows.tsx', source)).toEqual([
    coreMessage('phase'),
    coreMessage('plan'),
    coreMessage('plan'),
    coreMessage('questions'),
  ])
  expect(lint('core-tier-deps', 'extensions/phase/web.tsx', source)).toEqual([])
  expect(lint('core-tier-deps', 'test/example.test.ts', source)).toEqual([])
})
