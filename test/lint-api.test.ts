import { resolve } from 'node:path'
import { parseSync } from 'vite-plus'
import { expect, it } from 'vitest'
import ultimate from '../lint/ultimate.ts'

type Rule = keyof typeof ultimate.rules
type Located = { type: string; start: number; end: number; parent?: Located }
type Comment = { type: string; value: string; start: number; end: number }

/** Run one rule over `source` as oxlint would for `file` (repository-relative): parse, walk, report full messages. */
function diagnose(rule: Rule, file: string, source: string) {
  const lang = file.endsWith('.tsx') ? 'tsx' : 'ts'
  const { program, comments } = parseSync(file, source, { lang }) as unknown as {
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
    sourceCode: {
      text: source,
      getCommentsBefore,
      getCommentsInside: (node: Located) =>
        comments.filter((comment) => comment.start >= node.start && comment.end <= node.end),
      getAllComments: () => comments,
    },
    report: ({ message }) => reports.push(message),
  }) as Record<string, ((node: Located) => void) | undefined>
  const children = (node: Located) =>
    Object.entries(node).flatMap(([key, value]) =>
      key === 'parent'
        ? []
        : (Array.isArray(value) ? value : [value]).filter(
            (child): child is Located =>
              !!child && typeof child === 'object' && typeof child.type === 'string',
          ),
    )
  const link = (node: Located, parent?: Located) => {
    node.parent = parent
    for (const child of children(node)) link(child, node)
  }
  const visit = (node: Located) => {
    visitors[node.type]?.(node)
    for (const child of children(node)) visit(child)
  }
  link(program)
  visit(program)
  return reports
}

it('rejects hand-rolled polls of Ultimate and raw requests to /api, as extensions shipped them, and leaves other servers alone', () => {
  const polls = (file: string, source: string) =>
    diagnose('no-raw-stream', file, source).filter((message) =>
      message.includes('polls once per page'),
    )
  const sdk = "import { api, useAction } from '@/sdk/solid'\n"
  // extensions/status-line/status.solid.tsx at 54fadf9: its own 1 s loop.
  const rates = `${sdk}
    const poll = async () => {
      const next = await api.action(RatesAction, null, { signal: own.signal }).catch(() => null)
      cancel = retryAfter(1000, () => void poll())
    }`
  expect(polls('extensions/status-line/status.solid.tsx', rates)).toHaveLength(1)
  // extensions/automations/live.solid.tsx at 54fadf9: a refresh helper behind two timers.
  const automations = `${sdk}
    export const refreshList = () => refreshAutomations(api.action)
    export function useLive() {
      const refresh = () => void refreshList()
      createEffect(signature, (_, previous) => (previous === undefined ? undefined : retryAfter(100, refresh)))
      createEffect(late, (on) => {
        refresh()
        return every(2000, refresh)
      })
    }`
  expect(polls('extensions/automations/live.solid.tsx', automations)).toHaveLength(2)
  // extensions/mcp/chip.solid.tsx at 54fadf9: a refetch at each server's retry time beside useAction's every.
  const mcp = `${sdk}
    const { data: servers, refetch } = useAction(StatusAction, null, { every: settling })
    const refresh = () => void refetch()
    createEffect(retryAt, (at) => retryAfter(Math.max(0, at - Date.now()) + 500, refresh))`
  expect(polls('extensions/mcp/chip.solid.tsx', mcp)).toHaveLength(1)
  // extensions/system/surface.solid.tsx at 54fadf9: the lanes loaded every 2 s by hand.
  const lanes = `${sdk}
    const load = () => {
      void api.action(LanesAction, { since }, { signal: controller.signal }).then(
        (data) => setState({ range, data }),
        (error) => setState({ range, error }),
      )
    }
    load()
    const stop = live ? every(2000, load) : undefined`
  expect(polls('extensions/system/surface.solid.tsx', lanes)).toHaveLength(1)

  const aliased = `import { api as backend } from '@/sdk/solid'
    every(2000, () => void backend.action(ListAction).then(show))`
  expect(polls('extensions/mine/web.solid.tsx', aliased)).toHaveLength(1)
  const otherLibrary = `import { useAction } from 'some-query-library'
    const { refetch } = useAction('items')
    every(5000, () => void refetch())`
  expect(polls('extensions/mine/web.solid.tsx', otherLibrary)).toEqual([])
  const others = `${sdk}
    import { client } from './my-backend.ts'
    const query = useQuery()
    every(5000, () => void client.action('sync'))
    every(pollMs, () => void query.refetch())
    retryAfter(1000, () => setNow(Date.now()))
    every(10_000, () => api.action(PresentAction, { endpoint, visible: true }).catch(warn))`
  expect(polls('extensions/mine/web.solid.tsx', others)).toEqual([])

  const raw = `
    fetch('/api/extensions/mine/actions/list')
    fetch(\`/api/events/\${id}\`)
    new EventSource('/api/events')
    fetch('https://api.example.com/v1/items')
    fetch(\`\${backend}/items\`)
    new WebSocket('wss://example.com/live')
    every(1000, () => setNow(Date.now()))`
  expect(diagnose('no-raw-stream', 'extensions/mine/web.solid.tsx', raw)).toEqual(
    Array.from({ length: 3 }, () =>
      expect.stringMatching(/not fetch or a socket of your own to \/api/),
    ),
  )
})

/** The specific part of each message, after the sentence that says why the rule exists. */
const lint = (rule: Rule, file: string, source: string) =>
  diagnose(rule, file, source).map((message) => message.slice(message.indexOf('. ') + 2))

it('opens every contract and boundary message with why the rule exists', () => {
  const why = (rule: Rule, file: string, source: string) =>
    diagnose(rule, file, source).map((message) => message.slice(0, message.indexOf('. ') + 1))
  expect(why('api-file-shape', 'extensions/echo/api.ts', 'export const limit = 3')).toContain(
    'Agents and other extensions read a contract file as the whole surface (ultimate.api), so it holds only contracts, each documented.',
  )
  expect(
    why('api-naming', 'extensions/echo/refs.ts', "export const A = actionRef('messages', 'send')"),
  ).toEqual(['A name tells the reader who owns it.'])
  expect(
    why(
      'api-only-imports',
      'extensions/echo/server.ts',
      "import { x } from '../messages/server.ts'",
    ),
  ).toEqual(['Extensions meet only at their contracts, so each can change and reload on its own.'])
  expect(
    why(
      'core-tier-deps',
      'extensions/conversations/rows.solid.tsx',
      "import { x } from '../plan/ui.solid.tsx'",
    ),
  ).toEqual(['The core tier must run with every optional extension off.'])
})

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
import { defineEntry } from '@earendil-works/pi-durable'
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
/** One echo in the transcript; renderers in other extensions narrow with \`EchoEntry.is(entry)\`. */
export const EchoEntry = defineEntry<Echoed>('echo.entry')
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
    'refs.ts imports at runtime only shared/ and `defineEntry` from Pi Durable; use `import type` for the rest.',
    'refs.ts imports at runtime only shared/ and `defineEntry` from Pi Durable; use `import type` for the rest.',
    "refs.ts is browser-safe: it imports types only from packages, shared/ and extensions' refs.ts or types.ts.",
    "refs.ts is browser-safe: it imports types only from packages, shared/ and extensions' refs.ts or types.ts.",
    "refs.ts is browser-safe: it imports types only from packages, shared/ and extensions' refs.ts or types.ts.",
    "refs.ts is browser-safe: it imports types only from packages, shared/ and extensions' refs.ts or types.ts.",
    "Document each ref: what it holds, or an action's arguments and result.",
    'refs.ts holds only contracts: imports, `export const X = docRef/actionRef/defineEvent/defineEntry(...)` and types.',
  ])
  expect(
    lint('api-naming', 'extensions/echo/refs.ts', "export const A = actionRef('messages', 'send')"),
  ).toEqual(["extensions/echo refers only to its own actions: actionRef('echo', name)."])
})

it('asks ui.solid.tsx for a summary and nothing else', () => {
  expect(
    lint(
      'api-file-shape',
      'extensions/echo/ui.solid.tsx',
      "/** Echo's components for other extensions: the echo line. */\nexport { EchoLine } from './line.tsx'\nexport const x = 1\n",
    ),
  ).toEqual([])
  expect(
    lint('api-file-shape', 'extensions/echo/ui.solid.tsx', "export { EchoLine } from './line.tsx'"),
  ).toEqual([
    'Start ui.solid.tsx with a doc comment on what it offers; its first sentence is the one-line summary.',
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
  `echo imports ${file} at runtime; reach ${file.split('/')[0]} through its refs.ts (the refs of its documents and actions) or its ui.solid.tsx (its components, hooks and points), import types with \`import type\`, or move a pure helper to lib/.`

it('lets browser code reach another extension through its refs.ts or ui.solid.tsx, and its api.ts only for types', () => {
  const source = `import { ConversationRef } from '../conversations/ui.solid.tsx'
import { OverviewDoc } from '../conversations/refs.ts'
import { UnderUltimate } from '../sidebar/ui.solid.tsx'
import type { WorkspaceService } from '../workspaces/api.ts'
import type { Plan } from '../plan/web.solid.tsx'
import { LogDoc } from './refs.ts'
import { useWorkspaces } from '../workspaces/data.solid.tsx'
import { WorkspacesApi } from '../workspaces/api.ts'
export { TaskChip } from '../plan/chip.solid.tsx'`
  expect(lint('api-only-imports', 'extensions/echo/web.solid.tsx', source)).toEqual([
    browserMessage('workspaces/data.solid.tsx'),
    browserMessage('workspaces/api.ts'),
    browserMessage('plan/chip.solid.tsx'),
  ])
  const project = `import { BoardDoc } from '../board/refs.ts'
import { columns } from '../board/columns.ts'`
  expect(lint('api-only-imports', '.ultimate/extensions/echo/status.solid.tsx', project)).toEqual([
    browserMessage('board/columns.ts'),
  ])
})

it('sends a Solid form to the kit Form, whose submit Button keeps who submitted it', () => {
  const source = `export const Add = () => (
  <form onSubmit={(event) => event.preventDefault()}>
    <Form />
  </form>
)`
  expect(lint('ui-kit-roles', 'extensions/todos/panel.solid.tsx', source)).toEqual([
    `Use the kit's Form from @/components/ui and start the change in its type="submit" Button's onClick, which Enter in a field presses too.`,
  ])
  expect(lint('ui-kit-roles', 'web/src/components/ui/form.solid.tsx', source)).toEqual([])
})

it('sends a Solid bare button to the kit Button, which the agent bridge can see and press', () => {
  const source = `export const Open = () => (
  <button onClick={() => switchConversation(42)} type="button">
    #42
  </button>
)`
  expect(lint('ui-kit-roles', 'extensions/instance/link.solid.tsx', source)).toHaveLength(1)
  expect(lint('ui-kit-roles', 'extensions/instance/test/link.test.solid.tsx', source)).toEqual([])
  expect(lint('ui-kit-roles', 'web/src/components/ui/button.solid.tsx', source)).toEqual([])
})

it('rejects a pressed Button because the agent cannot read its state', () => {
  const source = `import { Button } from '@/components/ui/button.solid.tsx'
export const Fast = () => <Button aria-pressed={state().on ? 'true' : 'false'}>Fast mode</Button>`
  const check = (code: string) =>
    diagnose('no-aria-pressed-button', 'extensions/fast/toggle.solid.tsx', code)
  const message =
    'The agent bridge sees only press on a Button, never its pressed state. Use Toggle from @/components/ui/toggle.solid.tsx, or SegmentedControl or Tabs for a one-of-many selection.'
  expect(check(source)).toEqual([message])
  expect(
    check(`import { Toggle } from '@/components/ui/toggle.solid.tsx'
export const Fast = () => <Toggle pressed={state().on}>Fast mode</Toggle>`),
  ).toEqual([])
  expect(
    check(`import { Button as Action } from '@/components/ui/button.solid.tsx'
import { TooltipTrigger } from '@/components/ui/tooltip.solid.tsx'
import { PopoverTrigger } from '@/components/ui/popover.solid.tsx'
export const Fast = () => <>
  <TooltipTrigger aria-pressed="true" render={(trigger) => <Action {...trigger} />} />
  <PopoverTrigger aria-pressed="true" render={Action} />
  <TooltipTrigger aria-pressed="true" />
  <Action>Run</Action>
</>`),
  ).toEqual([message, message])
})

it('keeps server helpers out of web tests, which the web tsconfig type-checks', () => {
  const source = `import { until } from '../../../../test/helpers.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'`
  expect(
    lint(
      'no-server-helpers-in-web-tests',
      'extensions/fast/test/web/toggle.test.solid.tsx',
      source,
    ),
  ).toHaveLength(1)
})

it('keeps ui-sdk components behind the UI kit', () => {
  const source = `import { Switch } from '@ui-sdk/solid/switch'
import { createSignal } from 'solid-js'
import { useDoc } from '@/sdk/solid'
import { Button } from '@/components/ui/button.solid.tsx'`
  const message =
    'Import the component from @/components/ui; for a behavior the kit lacks, compose it with definePrimitive from @ui-sdk/core.'
  for (const file of [
    'extensions/echo/panel.solid.tsx',
    'web/src/app/panel.solid.tsx',
    '../my-app/.ultimate/extensions/echo/web.solid.tsx',
  ])
    expect(lint('ui-framework-boundaries', file, source)).toEqual([message])
  expect(lint('ui-framework-boundaries', 'web/src/components/ui/switch.solid.tsx', source)).toEqual(
    [],
  )
})

it('lets only the core hosts in web/src import the contribution bridge', () => {
  const source = `import { Contribution } from '@/sdk/contribution.solid.tsx'
const later = import(\`@/sdk/contribution.solid\`)`
  const onePath =
    "Hosts render every contribution through one path, with its extension scope and error isolation. Only the core hosts in web/src import the bridge (web/src/sdk/contribution.solid.tsx); an extension renders another's contribution with Contribution, Provided or Slot from @/sdk/solid."
  for (const file of ['web/src/app/transcript.solid.tsx', 'web/src/sdk/parts.solid.tsx'])
    expect(diagnose('ui-framework-boundaries', file, source)).toEqual([])
  expect(diagnose('ui-framework-boundaries', 'extensions/echo/panel.solid.tsx', source)).toEqual([
    onePath,
    onePath,
  ])
})

it('sends hand-made widget roles to the UI kit, outside the kit itself', () => {
  const source = `export const List = () => (
  <div role="listbox">
    <span role="option" />
    <span role="switch" />
    <span role={'slider'} />
    <span role={\`tab\`} />
    <span role={dynamic} />
    <span role={\`\${kind}\`} />
  </div>
)`
  expect(lint('ui-kit-roles', 'extensions/echo/list.solid.tsx', source)).toEqual([
    "Use the kit's Listbox or Select from @/components/ui.",
    "Use the kit's Switch from @/components/ui.",
    "Use the kit's Slider from @/components/ui.",
    "Use the kit's Tabs from @/components/ui.",
  ])
  expect(lint('ui-kit-roles', 'web/src/components/ui/listbox.solid.tsx', source)).toEqual([])
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
const later = () => import('../questions/web.solid.tsx')`
  expect(lint('core-tier-deps', 'extensions/conversations/rows.tsx', source)).toEqual([
    coreMessage('phase'),
    coreMessage('plan'),
    coreMessage('plan'),
    coreMessage('questions'),
  ])
  expect(lint('core-tier-deps', 'extensions/phase/web.solid.tsx', source)).toEqual([])
  expect(lint('core-tier-deps', 'test/example.test.ts', source)).toEqual([])
})

it('rejects every product comment except contract JSDoc, Pi upstream markers and copied licences', () => {
  // Shipped in server/api.ts and web/src/sdk/client.ts at 0e27be8.
  const server = `export async function invoke(data: object) {
    // Missing args mean none, so \`curl -d '{}'\` and agents can call argument-free actions.
    return Object.hasOwn(data, 'args')
  }`
  expect(lint('no-comments', 'server/api.ts', server)).toEqual([
    expect.stringMatching(/^An invariant .* becomes a name, a type or a small function/),
  ])
  const sdk = `/** How long the status line shows "ready · switching" before the page reloads onto a new bundle. */
const switchDelay = 600
/** Installed web facets of \`extensions/*\`. */
export const registry = createRegistry()
// Pi upstream: the event bus, adapted.
/** Compact token counts, as Pi's footer prints them. */
export function formatTokens(count: number) {}`
  expect(lint('no-comments', 'web/src/sdk/client.ts', sdk)).toHaveLength(2)
  const contract = `/**
 * Entry kinds that core extensions on both sides of a dependency read.
 */
import { defineEntry } from '@earendil-works/pi-durable'
/** A branch abstract: what a conversation did. */
export type AbstractData = {
  /** Where it stands. */
  at: number
}
/*
MIT License — Copyright (c) 2025 Mario Zechner
*/`
  expect(lint('no-comments', 'extensions/entries/refs.ts', contract)).toEqual([])
})

it('keeps Solid SDK contract JSDoc on the entry and on the exports it re-exports', () => {
  const entry = `/** The extension SDK for Solid facets. */
/** A card that folds. */
export { Fold } from '../app/fold.solid.tsx'`
  expect(lint('no-comments', 'web/src/sdk/solid.ts', entry)).toEqual([])
  const hooks = `/** Reads the document as an accessor. */
export function useDoc() {}
/** Shell navigation. */
export const { switchConversation } = actions
/** Keyed per conversation and kind. */
export const replicaKey = (kind: string) => kind`
  expect(lint('no-comments', 'web/src/sdk/hooks.ts', hooks)).toHaveLength(1)
  const parts = `/** Renders a slot by name. */
export function Slot() {}`
  expect(lint('no-comments', 'web/src/sdk/parts.solid.tsx', parts)).toEqual([])
})
