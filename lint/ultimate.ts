import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { apiSummary } from '../lib/api-files.ts'
import { coreTier } from '../shared/extension-api.ts'

interface ImportNode {
  type?: string
  source?: Node
  importKind?: string
  exportKind?: string
}

interface Node {
  type: string
  start?: number
  end?: number
  name?: string
  id?: Node
  specifiers?: { type?: string; imported?: Node; exported?: Node }[]
  source?: Node
  value?: unknown
  computed?: boolean
  key?: Node
  body?: Node | Node[]
  argument?: Node | null
  callee?: Node
  tag?: Node
  property?: Node
  object?: Node
  properties?: Node[]
  arguments?: Node[]
  parent?: Node | null
  importKind?: string
  exportKind?: string
  kind?: string
  declaration?: Node | null
  declarations?: Node[]
  expression?: Node
  operator?: string
  init?: Node | null
  typeArguments?: Node | null
  params?: Node[]
  typeName?: Node
  typeAnnotation?: Node | null
  members?: Node[]
  types?: Node[]
}

interface Context {
  filename: string
  options: unknown[]
  sourceCode: {
    text: string
    getCommentsBefore(node: Node): unknown[]
    getCommentsInside(node: Node): unknown[]
    getAllComments(): Comment[]
  }
  report(diagnostic: { node: ImportNode | Node; message: string }): void
}

interface Comment {
  type: string
  value: string
  start: number
  end: number
}

const extensionOf = (filename: string) => {
  const parts = path.relative(process.cwd(), filename).split(path.sep)
  const [directory, extension] = parts[0] === '.ultimate' ? parts.slice(1) : parts
  return directory === 'extensions' ? extension : undefined
}
/** The repository-relative path segments an import `source` of `filename` resolves to. */
const resolved = (filename: string, source: string) =>
  path.relative(process.cwd(), path.resolve(path.dirname(filename), source)).split(path.sep)
/**
 * An extension's contract files: `api.ts` for server code, `refs.ts` for the documents and actions the browser reads
 * and calls, `ui.tsx` for what other extensions' React code imports and `ui.solid.tsx` for what their Solid code imports.
 */
const contracts = ['api.ts', 'refs.ts', 'ui.tsx', 'ui.solid.tsx'] as const
type Contract = (typeof contracts)[number]
/** `extensions/<name>/<contract>`: the extension and which contract file it is. */
const contractFile = (filename: string) => {
  const parts = path.relative(process.cwd(), filename).split(path.sep)
  const file = parts[2] as Contract
  return parts.length === 3 && parts[0] === 'extensions' && contracts.includes(file)
    ? { extension: parts[1], file }
    : undefined
}
/** Whether repository-relative `target` is `extensions/<any>/<name>`. */
const extensionFile = (target: string[], ...names: string[]) =>
  target.length === 3 && target[0] === 'extensions' && names.includes(target[2])
/** Whether a JSDoc comment with text sits directly before `node`. */
const documented = (context: Context, node: Node) =>
  (context.sourceCode.getCommentsBefore(node) as { type: string; value: string }[]).some(
    (comment) => comment.type === 'Block' && /^\*\s*\S/.test(comment.value),
  )
/** The members of a type literal, or of the literals of an intersection. */
const literals = (type: Node | null | undefined): Node[] =>
  type?.type === 'TSTypeLiteral'
    ? (type.members ?? [])
    : type?.type === 'TSIntersectionType'
      ? (type.types ?? []).flatMap(literals)
      : []
/** The members of an exported service type: an interface, a type literal, or the literals of an intersection. */
const membersOf = (declaration: Node): Node[] =>
  declaration.type === 'TSInterfaceDeclaration'
    ? (((declaration.body as Node | undefined)?.body as Node[] | undefined) ?? [])
    : literals(declaration.typeAnnotation)
const repositoryPath = (filename: string) =>
  path.relative(process.cwd(), filename).split(path.sep).join('/')
const solidFile = (filename: string) => filename.endsWith('.solid.tsx')
const reactIslandFile = 'web/src/sdk/react-island.tsx'
const rendererBridges = new Set([
  'web/src/sdk/island.tsx',
  'web/src/sdk/solid.ts',
  'web/src/sdk/markdown.tsx',
  reactIslandFile,
])
const rendererBridge = (filename: string) => rendererBridges.has(repositoryPath(filename))
const solidSdk = 'web/src/sdk/solid.ts'
const reactSdk = (module: string) => {
  const file = repositoryPath(module)
  return file.startsWith('web/src/sdk/') && file !== solidSdk
}
const extensionWebFacet = (filename: string) =>
  /^(\.ultimate\/)?extensions\/[^/]+\/web\.tsx$/.test(repositoryPath(filename))
const uiKitFile = (filename: string) =>
  repositoryPath(filename).startsWith('web/src/components/ui/')
const reactOnly =
  /^(react|react-dom|lucide-react|radix-ui|cmdk|streamdown|use-stick-to-bottom|@radix-ui\/.*|@pierre\/diffs\/react)(\/|$)/
const solidOnly = /^(solid-js|@solidjs\/.*|@ui-sdk\/solid)(\/|$)/
const uiSdkComponents = /^@ui-sdk\/solid(\/|$)/
const solidJsxPragma = '@jsxImportSource @solidjs/web'
const isSolidJsxPragma = (comment: Comment | undefined) =>
  comment?.type === 'Block' && comment.value.trim().replace(/^\*\s*/, '') === solidJsxPragma
const moduleSuffixes = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']
const localModule = (filename: string, source: string) => {
  const base = source.startsWith('@/')
    ? path.resolve(process.cwd(), 'web/src', source.slice(2))
    : source.startsWith('.')
      ? path.resolve(path.dirname(filename), source)
      : undefined
  if (base === undefined) return undefined
  const found = moduleSuffixes
    .map((suffix) => base + suffix)
    .find((file) => existsSync(file) && statSync(file).isFile())
  return found ?? base
}
const staticString = (value: Node | null | undefined): unknown =>
  value?.type === 'JSXExpressionContainer'
    ? staticString(value.expression)
    : value?.type === 'TemplateLiteral' &&
        (value as { expressions?: unknown[] }).expressions?.length === 0
      ? (value as { quasis?: { value?: { cooked?: string } }[] }).quasis?.[0]?.value?.cooked
      : value?.value
const kitRoles = new Map([
  ['listbox', 'Listbox or Select'],
  ['menu', 'Menu'],
  ['menubar', 'Menubar'],
  ['dialog', 'Dialog'],
  ['alertdialog', 'AlertDialog'],
  ['tablist', 'Tabs'],
  ['tab', 'Tabs'],
  ['separator', 'Separator'],
  ['switch', 'Switch'],
  ['slider', 'Slider'],
  ['radiogroup', 'Radio'],
  ['toolbar', 'Toolbar'],
  ['tree', 'Tree'],
  ['combobox', 'Combobox'],
  ['tooltip', 'Tooltip'],
])
const onlyDefineEntry = (node: Node) =>
  node.source?.value === '@earendil-works/pi-durable' &&
  node.specifiers?.length === 1 &&
  node.specifiers[0].imported?.name === 'defineEntry'

const definers: Record<'api.ts' | 'refs.ts', Set<string>> = {
  'api.ts': new Set(['defineApi', 'defineDoc', 'defineEntry']),
  'refs.ts': new Set(['docRef', 'actionRef', 'defineEvent', 'defineEntry']),
}

/** The declarator of `export const tier = …`, which declares an extension's tier, if `statement` is one. */
const tierOf = (statement: Node) =>
  statement.type === 'ExportNamedDeclaration' &&
  statement.declaration?.type === 'VariableDeclaration'
    ? statement.declaration.declarations?.find((declarator) => declarator.id?.name === 'tier')
    : undefined

const tiers = new Map<string, boolean>()
/** Whether `extensions/<name>` declares the core tier in its api.ts (`coreTier`), read once per lint process. */
function coreExtension(name: string) {
  let core = tiers.get(name)
  if (core === undefined) {
    const file = path.join(process.cwd(), 'extensions', name, 'api.ts')
    core = existsSync(file) && coreTier.test(readFileSync(file, 'utf8'))
    tiers.set(name, core)
  }
  return core
}

const propertyName = (node: Node | undefined) =>
  node?.computed ? node.property?.value : (node?.property?.name ?? node?.property?.value)
const hasOption = (node: Node, name: string) =>
  node.type === 'ObjectExpression' &&
  node.properties?.some(
    (property) =>
      (property.computed ? property.key?.value : (property.key?.name ?? property.key?.value)) ===
      name,
  )
const root = (node: Node | undefined): Node | undefined => {
  if (node?.type === 'MemberExpression') return root(node.object)
  if (node?.type === 'CallExpression') return root(node.callee)
  if (node?.type === 'TaggedTemplateExpression') return root(node.tag)
  return node
}

/** `name` or `window.name` / `globalThis.name`. */
const isGlobal = (node: Node | undefined, name: string) =>
  node?.type === 'Identifier'
    ? node.name === name
    : node?.type === 'MemberExpression' &&
      node.object?.type === 'Identifier' &&
      ['window', 'globalThis'].includes(node.object.name ?? '') &&
      propertyName(node) === name

const isJsDoc = (comment: Comment) => comment.type === 'Block' && comment.value.startsWith('*')
const inSdk = (filename: string) =>
  path.relative(process.cwd(), filename).startsWith(`web${path.sep}src${path.sep}sdk${path.sep}`)
let sdkExports: Set<string> | undefined
/** The names `web/src/sdk/index.ts` exports: the SDK's public surface, read once per lint process. */
function publicSdk() {
  sdkExports ??= new Set(
    [
      ...readFileSync(path.join(process.cwd(), 'web/src/sdk/index.ts'), 'utf8').matchAll(
        /export\s+(?:type\s+)?\{([^}]*)\}/g,
      ),
    ].flatMap((match) =>
      match[1].split(',').map((name) =>
        name
          .trim()
          .split(/\s+as\s+/)
          .pop()!,
      ),
    ),
  )
  return sdkExports
}
/** The names an `export` statement declares or passes on. */
const exportedNames = (statement: Node): string[] => {
  const declaration = statement.declaration
  if (!declaration)
    return (statement.specifiers ?? []).map((specifier) => String(specifier.exported?.name))
  if (declaration.type === 'VariableDeclaration')
    return (declaration.declarations ?? []).map((declarator) => String(declarator.id?.name))
  return [String(declaration.id?.name)]
}
const functionTypes = ['FunctionDeclaration', 'ArrowFunctionExpression', 'FunctionExpression']
/** Whether an export is a function, whose body is implementation rather than contract. */
const hasBody = (statement: Node) =>
  functionTypes.includes(statement.declaration?.type ?? '') ||
  (statement.declaration?.declarations ?? []).some((declarator) =>
    functionTypes.includes(declarator.init?.type ?? ''),
  )
/** The SDK's public entries: `@/sdk` for React, `@/sdk/solid` for Solid. */
const sdkEntry = (filename: string) =>
  ['web/src/sdk/index.ts', solidSdk].includes(repositoryPath(filename))
/**
 * Where JSDoc is a contract: the statements of a contract file, or the exports of an SDK entry's public names, and the
 * core's temporary `reactIsland`, which no SDK entry exports.
 */
function contractStatements(filename: string, statements: Node[]) {
  if (contractFile(filename)) return statements
  if (repositoryPath(filename) === solidSdk)
    return statements.filter((statement) => statement.type === 'ExportNamedDeclaration')
  if (!inSdk(filename)) return []
  const names =
    repositoryPath(filename) === reactIslandFile ? new Set(['reactIsland']) : publicSdk()
  return statements.filter(
    (statement) =>
      statement.type === 'ExportNamedDeclaration' &&
      exportedNames(statement).some((name) => names.has(name)),
  )
}

export default {
  meta: { name: 'ultimate' },
  rules: {
    'no-comments': {
      meta: { schema: [] },
      create(context: Context) {
        return {
          Program(program: Node) {
            const statements = (program.body as Node[] | undefined) ?? []
            const contractDocs = new Set<number>()
            for (const statement of contractStatements(context.filename, statements))
              for (const comment of [
                ...(context.sourceCode.getCommentsBefore(statement) as Comment[]),
                ...(hasBody(statement)
                  ? []
                  : (context.sourceCode.getCommentsInside(statement) as Comment[])),
              ])
                contractDocs.add(comment.start)
            const opening = context.sourceCode.getAllComments()[0]
            if (
              opening &&
              (contractFile(context.filename) || sdkEntry(context.filename)) &&
              (statements.length === 0 || opening.end <= statements[0].start!)
            )
              contractDocs.add(opening.start)
            for (const comment of context.sourceCode.getAllComments()) {
              if (
                comment.type === 'Shebang' ||
                /^\s*Pi upstream:|License — Copyright/.test(comment.value) ||
                (solidFile(context.filename) && isSolidJsxPragma(comment))
              )
                continue
              if (isJsDoc(comment) && contractDocs.has(comment.start)) continue
              context.report({
                node: comment,
                message:
                  'A comment is an excuse for unclear code: make the names and structure say it. An invariant (ordering, durability, replay) becomes a name, a type or a small function; a workaround keeps its why in the commit message and a regression test. Only contract JSDoc (on the exports of api.ts, refs.ts, ui.tsx and web/src/sdk), `Pi upstream:` markers and licence headers of copied code stay.',
              })
            }
          },
        }
      },
    },
    'ui-framework-boundaries': {
      meta: { schema: [] },
      create(context: Context) {
        const solid = solidFile(context.filename)
        const check = (node: ImportNode) => {
          const source = staticString(node.source)
          if (typeof source !== 'string') return
          if (node.importKind === 'type' || node.exportKind === 'type') return
          const local = localModule(context.filename, source)
          if (local !== undefined && repositoryPath(local) === reactIslandFile) {
            if (!repositoryPath(context.filename).startsWith('web/src/app/'))
              context.report({
                node,
                message: `reactIsland is a temporary bridge for the core switch: only the core hosts in web/src/app mount leftover React in Solid, and C5 deletes it with React. Move this part to Solid, or keep it React and contribute it where a core host renders React.`,
              })
            return
          }
          const localReact = local?.endsWith('.tsx') === true && !solidFile(local)
          const localSolid =
            local !== undefined && (solidFile(local) || repositoryPath(local) === solidSdk)
          const islandComponent =
            local !== undefined &&
            solidFile(local) &&
            node.type === 'ImportDeclaration' &&
            extensionWebFacet(context.filename)
          if (solid && (reactOnly.test(source) || localReact))
            context.report({
              node,
              message: `A Solid file renders with Solid alone, so React code in it never runs as written. Replace ${source} with its Solid counterpart: our UI kit (@/components/ui), @lucide/solid for icons, or a ui-sdk component in the kit.`,
            })
          else if (solid && local !== undefined && reactSdk(local))
            context.report({
              node,
              message: `@/sdk is the SDK for React: its hooks run only inside a React render, so in a Solid file they throw or never update. Import the Solid bindings from @/sdk/solid instead of ${source}; types may still come from @/sdk with \`import type\`.`,
            })
          else if (
            !solid &&
            !rendererBridge(context.filename) &&
            !islandComponent &&
            (solidOnly.test(source) || localSolid)
          )
            context.report({
              node,
              message: `React and Solid meet only in the SDK's island mount, so each file has one renderer and one set of JSX types. Move this code into a .solid.tsx file, or import the Solid component in your extension's web.tsx and contribute it as island(Component) from @/sdk instead of importing ${source} here.`,
            })
          else if (
            uiSdkComponents.test(source) &&
            !uiKitFile(context.filename) &&
            !inSdk(context.filename)
          )
            context.report({
              node,
              message: `ui-sdk is in beta and changes weekly, so its components are wrapped once in our UI kit, which also carries the theme. Import the component from @/components/ui; for a behavior the kit lacks, compose it with definePrimitive from @ui-sdk/core.`,
            })
        }
        return {
          ImportDeclaration: check,
          ImportExpression: check,
          ExportNamedDeclaration: check,
          ExportAllDeclaration: check,
        }
      },
    },
    'solid-jsx-pragma': {
      meta: { schema: [] },
      create(context: Context) {
        if (!solidFile(context.filename)) return {}
        return {
          Program(program: Node) {
            const first = context.sourceCode.getAllComments()[0] as Comment | undefined
            const statements = (program.body as Node[] | undefined) ?? []
            if (
              !isSolidJsxPragma(first) ||
              (statements.length > 0 && first!.end > statements[0].start!)
            )
              context.report({
                node: program,
                message: `A Solid file shares the type-check project with React files, and TypeScript reads the JSX source only from a leading block comment, so without it the JSX is checked against React's types. Open the file with /** ${solidJsxPragma} */.`,
              })
          },
        }
      },
    },
    'ui-kit-roles': {
      meta: { schema: [] },
      create(context: Context) {
        if (uiKitFile(context.filename)) return {}
        return {
          JSXOpeningElement(node: Node & { name?: Node }) {
            if (node.name?.type === 'JSXIdentifier' && node.name.name === 'form')
              context.report({
                node,
                message:
                  "A native form submit carries no source, so a change an agent submits is recorded as the person's. Use the kit's Form from @/components/ui and start the change in its type=\"submit\" Button's onClick, which Enter in a field presses too.",
              })
          },
          JSXAttribute(node: Node & { name?: Node }) {
            if (node.name?.name !== 'role') return
            const role = staticString(node.value as Node | null | undefined)
            if (typeof role !== 'string') return
            const component = kitRoles.get(role)
            if (component)
              context.report({
                node,
                message: `A hand-made role="${role}" lacks the keyboard, focus and ARIA behavior people and agents rely on, and the agent bridge cannot see it. Use the kit's ${component} from @/components/ui.`,
              })
          },
        }
      },
    },
    'no-raw-stream': {
      meta: { schema: [] },
      create(context: Context) {
        const message =
          'One way to the server keeps every page live, reconnecting and replay-safe: read state with useDoc/useDocOf and call the server with useAction or api.action from @/sdk (docs/extensions/sdk.md), not fetch or a socket of your own.'
        return {
          CallExpression(node: Node) {
            if (isGlobal(node.callee, 'fetch')) context.report({ node, message })
          },
          NewExpression(node: Node) {
            if (isGlobal(node.callee, 'EventSource') || isGlobal(node.callee, 'WebSocket'))
              context.report({ node, message })
          },
        }
      },
    },
    'no-real-wait-in-fast-tests': {
      meta: { schema: [] },
      create(context: Context) {
        const exempt = (node: Node) => {
          let current: Node | null | undefined = node
          while (current) {
            if (
              context.sourceCode
                .getCommentsBefore(current)
                .some((comment) =>
                  /fast-test-reason:\s*\S/.test((comment as { value: string }).value),
                )
            )
              return true
            current = current.parent
          }
          return false
        }
        const report = (node: Node) => {
          if (!exempt(node))
            context.report({
              node,
              message:
                'A real wait or process makes pnpm test slow and flaky: use fake timers, or move the test to a test/e2e folder. A justified exception needs a fast-test-reason: comment.',
            })
        }
        return {
          ImportDeclaration(node: Node) {
            const source = typeof node.source?.value === 'string' ? node.source.value : ''
            if (
              /^(node:)?child_process$|^execa(?:\/|$)|^(spawn|execFile)$/.test(source) ||
              (/^(node:)?timers\/promises$/.test(source) &&
                node.specifiers?.some(
                  (specifier) =>
                    specifier.imported?.name === 'setTimeout' ||
                    specifier.type === 'ImportNamespaceSpecifier',
                ))
            )
              report(node)
          },
          ImportExpression(node: Node) {
            if (
              typeof node.source?.value === 'string' &&
              /^(node:)?child_process$|^execa(?:\/|$)/.test(node.source.value)
            )
              report(node)
          },
          CallExpression(node: Node) {
            if (!isGlobal(node.callee, 'setTimeout')) return
            let parent = node.parent
            while (parent && parent.type !== 'NewExpression') parent = parent.parent
            if (
              parent?.callee?.name === 'Promise' &&
              !/\bvi\.useFakeTimers\s*\(/.test(context.sourceCode.text)
            )
              report(node)
          },
        }
      },
    },
    'no-raw-timer': {
      meta: { schema: [] },
      create(context: Context) {
        const message =
          'A timer guesses when something has happened, so it is slow when it waits too long and wrong when it waits too little: react to the event, document, observer or AbortSignal that says so. When time itself is the reason, use the helper from lib/timers.ts that names it (debounce, batch, deadline, within, retryAfter, every, pace, nextTurn).'
        const imported = (node: Node) => {
          if (/^(node:)?timers(\/promises)?$/.test(String(node.source?.value)))
            context.report({ node, message })
        }
        return {
          CallExpression(node: Node) {
            if (isGlobal(node.callee, 'setTimeout') || isGlobal(node.callee, 'setInterval'))
              context.report({ node, message })
          },
          ImportDeclaration: imported,
          ImportExpression: imported,
        }
      },
    },
    'no-local-test-polling': {
      meta: { schema: [] },
      create(context: Context) {
        return {
          FunctionDeclaration(node: Node) {
            if (['until', 'waitFor'].includes(node.id?.name ?? ''))
              context.report({
                node,
                message:
                  'One polling helper with a real deadline keeps waits in tests consistent: use until from test/helpers.ts instead of a local one.',
              })
          },
        }
      },
    },
    'no-server-helpers-in-web-tests': {
      meta: { schema: [] },
      create(context: Context) {
        const check = (node: ImportNode) => {
          const source = node.source?.value
          if (typeof source !== 'string' || !source.startsWith('.')) return
          if (resolved(context.filename, source).join('/') === 'test/helpers.ts')
            context.report({
              node,
              message:
                "test/helpers.ts imports the server, and a web test is type-checked by tsconfig.web.json, which then fails as 'Invalid tsconfig'. Use the browser-safe helpers in test/web (solid-dom-setup.ts, fake-source.ts, agent-names.ts) and vi.advanceTimersByTimeAsync or settle() instead of until.",
            })
        }
        return { ImportDeclaration: check, ImportExpression: check }
      },
    },
    'no-test-timeout': {
      meta: { schema: [] },
      create(context: Context) {
        return {
          CallExpression(node: Node) {
            const callee = node.callee
            const base = root(callee)
            const args = node.arguments ?? []
            const testCall =
              base?.type === 'Identifier' && ['it', 'test', 'describe'].includes(base.name ?? '')
            const configCall =
              callee?.type === 'MemberExpression' &&
              callee.object?.type === 'Identifier' &&
              callee.object.name === 'vi' &&
              propertyName(callee) === 'setConfig'
            if (
              (testCall &&
                args
                  .slice(1)
                  .some((arg) => typeof arg.value === 'number' || hasOption(arg, 'timeout'))) ||
              (configCall && args.some((arg) => hasOption(arg, 'testTimeout')))
            )
              context.report({
                node,
                message:
                  'A raised timeout hides a slow or flaky test instead of fixing it: make the test fast and deterministic, or delete it.',
              })
          },
        }
      },
    },
    'replay-safe-by-name': {
      meta: { schema: [] },
      create(context: Context) {
        return {
          Property(node: Node & { value: Node }) {
            if (
              (node.computed
                ? node.key?.value === 'replay'
                : (node.key?.name ?? node.key?.value) === 'replay') &&
              node.value.type === 'Literal' &&
              node.value.value === 'safe'
            )
              context.report({
                node,
                message:
                  'After a crash, replay runs a call again, so a call with effects would repeat them: spread ...readOnly for a tool that only reads, or ...safeToRerun(why a rerun does no harm), from lib/replay.ts.',
              })
          },
        }
      },
    },
    'no-unowned-work': {
      meta: { schema: [] },
      create(context: Context) {
        const message =
          'Work started and not awaited is lost on a crash and never retried: create it as a task in the commit that decides it (defineEffect from lib/effect.ts), or await it. Name the two exceptions from lib/errors.ts: rebuiltOnOpen(why, work) when open derives it again (a projection, a cache, a sweep), inProcess(why, work) when it belongs to this process only (a request, a stream, a child process, shutdown).'
        const unowned = (node: Node | undefined): boolean => {
          if (node?.type === 'UnaryExpression' && node.operator === 'void')
            return node.argument?.type === 'CallExpression'
          if (node?.type !== 'CallExpression') return false
          if (node.callee?.type === 'Identifier' && node.callee.name === 'inBackground') return true
          return (
            node.callee?.type === 'MemberExpression' &&
            ['catch', 'then', 'finally'].includes(String(propertyName(node.callee)))
          )
        }
        return {
          ExpressionStatement(node: Node) {
            if (unowned(node.expression)) context.report({ node, message })
          },
        }
      },
    },
    'no-silent-catch': {
      meta: { schema: [] },
      create(context: Context) {
        const check = (node: Node) =>
          context.report({
            node,
            message:
              'A swallowed error hides a bug where nobody looks: handle it, or let it go by name from lib/errors.ts (ignoring(isMissing), meansNone, overshadowed, settled; keepLast for a read in the browser).',
          })
        const empty = (fn: Node | undefined) => {
          if (!fn || !['ArrowFunctionExpression', 'FunctionExpression'].includes(fn.type))
            return false
          const body = fn.body as Node
          return (
            (body.type === 'Identifier' && body.name === 'undefined') ||
            (body.type === 'BlockStatement' &&
              Array.isArray(body.body) &&
              (body.body.length === 0 ||
                (body.body.length === 1 &&
                  body.body[0].type === 'ReturnStatement' &&
                  (!body.body[0].argument ||
                    (body.body[0].argument.type === 'Identifier' &&
                      body.body[0].argument.name === 'undefined')))))
          )
        }
        return {
          CallExpression(node: Node) {
            const callee = node.callee
            if (
              callee?.type !== 'MemberExpression' ||
              (callee.computed ? callee.property?.value : callee.property?.name) !== 'catch'
            )
              return
            const handler = node.arguments?.[0]
            if (empty(handler)) check(handler!)
          },
          Property(node: Node & { value: Node }) {
            if ((node.key?.name ?? node.key?.value) === 'onError' && empty(node.value)) check(node)
          },
          CatchClause(node: Node) {
            const block = node.body as Node
            if (Array.isArray(block.body) && block.body.length === 0) check(node)
          },
        }
      },
    },
    'api-only-imports': {
      meta: { schema: [] },
      create(context: Context) {
        const own = extensionOf(context.filename)
        if (!own) return {}
        const solid = solidFile(context.filename)
        const browser = context.filename.endsWith('.tsx')
        const allowed = solid ? ['refs.ts', 'ui.solid.tsx'] : browser ? ['ui.tsx'] : ['api.ts']
        const how = solid
          ? 'its refs.ts (the refs of its documents and actions) or its ui.solid.tsx (its Solid components; its ui.tsx is React)'
          : browser
            ? 'its ui.tsx (components, hooks and the refs of its documents and actions)'
            : 'its api.ts (a service, document or event token)'
        const check = (node: ImportNode) => {
          const source = node.source?.value
          if (typeof source !== 'string' || !source.startsWith('.')) return
          if (node.importKind === 'type' || node.exportKind === 'type') return
          const target = resolved(context.filename, source)
          const [directory, extension, ...file] =
            target[0] === '.ultimate' ? target.slice(1) : target
          if (directory === 'extensions' && extension !== own && !allowed.includes(file.join('/')))
            context.report({
              node,
              message: `Extensions meet only at their contracts, so each can change and reload on its own. ${own} imports ${extension}/${file.join('/')} at runtime; reach ${extension} through ${how}, import types with \`import type\`, or move a pure helper to lib/.`,
            })
        }
        return {
          ImportDeclaration: check,
          ImportExpression: check,
          ExportNamedDeclaration: check,
          ExportAllDeclaration: check,
        }
      },
    },
    'core-tier-deps': {
      meta: { schema: [] },
      create(context: Context) {
        const own = extensionOf(context.filename)
        if (!own || !coreExtension(own)) return {}
        // A core-tier extension relies only on the core tier, by runtime or type import alike; an optional extension
        // reaches the core through a point the core declares (a web point, an extension point or an event).
        const check = (node: ImportNode) => {
          const source = node.source?.value
          if (typeof source !== 'string' || !source.startsWith('.')) return
          const [directory, extension] = resolved(context.filename, source)
          if (directory === 'extensions' && extension !== own && !coreExtension(extension))
            context.report({
              node,
              message: `The core tier must run with every optional extension off. ${own} is core tier and imports optional ${extension}; declare a point in ${own} that ${extension} provides, or react to an event.`,
            })
        }
        return {
          ImportDeclaration: check,
          ImportExpression: check,
          ExportNamedDeclaration: check,
          ExportAllDeclaration: check,
        }
      },
    },
    'api-file-shape': {
      meta: { schema: [] },
      create(context: Context) {
        const contract = contractFile(context.filename)
        if (!contract) return {}
        const { file } = contract
        const report = (node: Node, message: string) =>
          context.report({
            node,
            message: `Agents and other extensions read a contract file as the whole surface (ultimate.api), so it holds only contracts, each documented. ${message}`,
          })
        const checkImport = (node: Node) => {
          const source = String(node.source?.value)
          if (source.startsWith('node:'))
            return report(node, `${file} is a contract: it imports no node:* module.`)
          const target = source.startsWith('.') ? resolved(context.filename, source) : undefined
          if (file === 'refs.ts') {
            // The browser imports refs.ts (tsconfig.web.json), so it may not reach server code even for types.
            if (node.importKind !== 'type')
              return target?.[0] === 'shared' || onlyDefineEntry(node)
                ? undefined
                : report(
                    node,
                    'refs.ts imports at runtime only shared/ and `defineEntry` from Pi Durable; use `import type` for the rest.',
                  )
            if (
              target &&
              (['server', 'bin', 'lib', 'web'].includes(target[0]) ||
                (target[0] === 'extensions' && !extensionFile(target, 'refs.ts', 'types.ts')))
            )
              report(
                node,
                "refs.ts is browser-safe: it imports types only from packages, shared/ and extensions' refs.ts or types.ts.",
              )
            return
          }
          if (node.importKind === 'type' || !target) return
          const ownRefs = target.join('/') === `extensions/${contract.extension}/refs.ts`
          if (target[0] !== 'shared' && !extensionFile(target, 'api.ts') && !ownRefs)
            report(
              node,
              "api.ts imports at runtime only shared/, packages, its refs.ts and other extensions' api.ts; use `import type` for the rest.",
            )
        }
        // api.ts passes on what its own refs.ts defines (event tokens), so server code imports one file.
        const ownRefs = (statement: Node) =>
          file === 'api.ts' &&
          statement.type === 'ExportNamedDeclaration' &&
          statement.source?.value === './refs.ts'
        return {
          Program(node: Node) {
            if (!apiSummary(context.sourceCode.text))
              report(
                node,
                `Start ${file} with a doc comment on what it offers; its first sentence is the one-line summary.`,
              )
            if (file === 'ui.tsx' || file === 'ui.solid.tsx') return
            const allowed = definers[file]
            const services = new Set<string>()
            const body = (node.body as Node[] | undefined) ?? []
            for (const statement of body) {
              if (statement.type === 'ImportDeclaration') checkImport(statement)
              else if (
                statement.type === 'TSTypeAliasDeclaration' ||
                statement.type === 'TSInterfaceDeclaration'
              )
                continue
              else if (
                ownRefs(statement) ||
                (statement.type === 'ExportNamedDeclaration' &&
                  (statement.exportKind === 'type' ||
                    (!statement.source &&
                      (statement.declaration?.type === 'TSTypeAliasDeclaration' ||
                        statement.declaration?.type === 'TSInterfaceDeclaration'))))
              )
                continue
              else if (file === 'api.ts' && tierOf(statement) !== undefined) {
                if (!coreTier.test(context.sourceCode.text))
                  report(
                    statement,
                    "An extension declares its tier as `export const tier = 'core'` or not at all.",
                  )
              } else if (
                statement.type === 'ExportNamedDeclaration' &&
                statement.declaration?.type === 'VariableDeclaration' &&
                statement.declaration.kind === 'const' &&
                statement.declaration.declarations?.every((declarator) =>
                  allowed.has(root(declarator.init ?? undefined)?.name ?? ''),
                )
              ) {
                if (!documented(context, statement))
                  report(
                    statement,
                    file === 'refs.ts'
                      ? "Document each ref: what it holds, or an action's arguments and result."
                      : 'Document each exported token: what it is and when to use it.',
                  )
                for (const declarator of statement.declaration.declarations) {
                  const inner = declarator.init?.callee
                  const service = inner?.typeArguments?.params?.[0]?.typeName?.name
                  if (inner?.callee?.name === 'defineApi' && service) services.add(service)
                }
              } else
                report(
                  statement,
                  file === 'refs.ts'
                    ? 'refs.ts holds only contracts: imports, `export const X = docRef/actionRef/defineEvent/defineEntry(...)` and types.'
                    : "api.ts holds only contracts: imports, `export const X = defineApi/defineDoc/defineEntry(...)`, re-exports of its refs.ts (where event tokens live, for the browser too), types and `export const tier = 'core'`.",
                )
            }
            for (const statement of body) {
              const declaration =
                statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
              const name = declaration?.id?.name
              if (!declaration || !name || !services.has(name)) continue
              for (const member of membersOf(declaration))
                if (!documented(context, member))
                  report(
                    member,
                    `Document ${name}.${String(member.key?.name ?? member.key?.value)}: what it does and when to call it.`,
                  )
            }
          },
        }
      },
    },
    'api-naming': {
      meta: { schema: [] },
      create(context: Context) {
        const contract = contractFile(context.filename)
        if (!contract || contract.file === 'ui.tsx' || contract.file === 'ui.solid.tsx') return {}
        const own = contract.extension
        return {
          CallExpression(node: Node) {
            const callee = node.callee
            const name = node.arguments?.[0]?.value
            if (callee?.type === 'Identifier' && callee.name === 'actionRef' && name !== own)
              context.report({
                node,
                message: `A name tells the reader who owns it. extensions/${own} refers only to its own actions: actionRef('${own}', name).`,
              })
            if (
              callee?.type === 'CallExpression' &&
              callee.callee?.type === 'Identifier' &&
              callee.callee.name === 'defineApi' &&
              !(
                name === own ||
                (typeof name === 'string' &&
                  /^[a-z][a-z0-9-]*$/.test(name.slice(own.length + 1)) &&
                  name.startsWith(`${own}.`))
              )
            )
              context.report({
                node,
                message: `A name tells the reader who owns it. The API of extensions/${own} is named '${own}', its extension points '${own}.<point>'.`,
              })
            if (
              callee?.type === 'Identifier' &&
              callee.name === 'defineEvent' &&
              !(
                typeof name === 'string' &&
                ((name.startsWith(`${own}.`) && name.length > own.length + 1) ||
                  (own === 'messages' && name === 'board.sent'))
              )
            )
              context.report({
                node,
                message: `A name tells the reader who owns it. Events of extensions/${own} are named '${own}.<event>'.`,
              })
          },
        }
      },
    },
  },
}
