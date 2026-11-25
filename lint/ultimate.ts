import { existsSync, readFileSync, statSync } from 'node:fs'
import { webModule } from '../lib/web-alias.ts'
import path from 'node:path'
import { apiSummary } from '../lib/api-files.ts'
import { coreTier } from '../shared/extension-api.ts'
import { declaredExtensions } from '../lib/declared.ts'

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
  specifiers?: { type?: string; imported?: Node; exported?: Node; local?: Node }[]
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

const extensionFolderOf = (filename: string) => {
  const parts = path.relative(process.cwd(), filename).split(path.sep)
  const at = parts[0] === '.ultimate' ? 1 : 0
  return parts[at] === 'extensions' && parts[at + 1] ? parts.slice(0, at + 2).join('/') : undefined
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
 * and calls, and `ui.solid.tsx` for what other extensions' browser code imports.
 */
const contracts = ['api.ts', 'refs.ts', 'ui.solid.tsx'] as const
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
const bridgeFile = 'web/src/sdk/contribution.solid.tsx'
const sdkEntries = ['web/src/sdk/solid.ts']
const uiKitFile = (filename: string) =>
  repositoryPath(filename).startsWith('web/src/components/ui/')
const uiSdkComponents = /^@ui-sdk\/solid(\/|$)/
const moduleSuffixes = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']
const localModule = (filename: string, source: string) => {
  const base = source.startsWith('@/')
    ? webModule(process.cwd(), source)
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

/** `export const requires = [...]` or `export const wants = [...]`, an api.ts's declared extensions. */
const declarationOf = (statement: Node) =>
  statement.type === 'ExportNamedDeclaration' &&
  statement.declaration?.type === 'VariableDeclaration' &&
  statement.declaration.declarations?.length === 1 &&
  ['requires', 'wants'].includes(statement.declaration.declarations[0].id?.name ?? '')

const apiTexts = new Map<string, string>()
function apiText(folder: string) {
  let text = apiTexts.get(folder)
  if (text === undefined) {
    const file = path.join(process.cwd(), folder, 'api.ts')
    text = existsSync(file) ? readFileSync(file, 'utf8') : ''
    apiTexts.set(folder, text)
  }
  return text
}

const coreExtension = (name: string) => coreTier.test(apiText(path.join('extensions', name)))

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

function walk(node: Node, visit: (node: Node) => void) {
  visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue
    for (const child of Array.isArray(value) ? value : [value])
      if (child && typeof child === 'object' && typeof (child as Node).type === 'string')
        walk(child as Node, visit)
  }
}

const isJsDoc = (comment: Comment) => comment.type === 'Block' && comment.value.startsWith('*')
const inSdk = (filename: string) => repositoryPath(filename).startsWith('web/src/sdk/')
let sdkExports: Set<string> | undefined
function publicSdk() {
  sdkExports ??= new Set(
    sdkEntries
      .flatMap((entry) => [
        ...readFileSync(path.join(process.cwd(), entry), 'utf8').matchAll(
          /export\s+(?:type\s+)?\{([^}]*)\}/g,
        ),
      ])
      .flatMap((match) =>
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
    return (declaration.declarations ?? []).flatMap(({ id }) =>
      id?.type === 'ObjectPattern'
        ? (id.properties ?? []).map((property) =>
            String((property.value as Node | undefined)?.name),
          )
        : [String(id?.name)],
    )
  return [String(declaration.id?.name)]
}
const functionTypes = ['FunctionDeclaration', 'ArrowFunctionExpression', 'FunctionExpression']
/** Whether an export is a function, whose body is implementation rather than contract. */
const hasBody = (statement: Node) =>
  functionTypes.includes(statement.declaration?.type ?? '') ||
  (statement.declaration?.declarations ?? []).some((declarator) =>
    functionTypes.includes(declarator.init?.type ?? ''),
  )
const sdkEntry = (filename: string) => sdkEntries.includes(repositoryPath(filename))
/** Where JSDoc is a contract: the statements of a contract file, or the exports of an SDK entry's public names. */
function contractStatements(filename: string, statements: Node[]) {
  if (contractFile(filename)) return statements
  if (!inSdk(filename)) return []
  const names = publicSdk()
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
                /^\s*Pi upstream:|License — Copyright/.test(comment.value)
              )
                continue
              if (isJsDoc(comment) && contractDocs.has(comment.start)) continue
              context.report({
                node: comment,
                message:
                  'A comment is an excuse for unclear code: make the names and structure say it. An invariant (ordering, durability, replay) becomes a name, a type or a small function; a workaround keeps its why in the commit message and a regression test. Only contract JSDoc (on the exports of api.ts, refs.ts, ui.solid.tsx and web/src/sdk), `Pi upstream:` markers and licence headers of copied code stay.',
              })
            }
          },
        }
      },
    },
    'ui-framework-boundaries': {
      meta: { schema: [] },
      create(context: Context) {
        const check = (node: ImportNode) => {
          const source = staticString(node.source)
          if (typeof source !== 'string') return
          const local = localModule(context.filename, source)
          const target = local === undefined ? undefined : repositoryPath(local)
          if (
            target === bridgeFile &&
            !/^web\/src\/(app|sdk)\//.test(repositoryPath(context.filename))
          )
            return context.report({
              node,
              message: `Hosts render every contribution through one path, with its extension scope and error isolation. Only the core hosts in web/src import the bridge (${bridgeFile}); an extension renders another's contribution with Contribution, Provided or Slot from @/sdk/solid.`,
            })
          const typeOnly =
            node.type === 'TSImportType' || node.importKind === 'type' || node.exportKind === 'type'
          if (
            !typeOnly &&
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
          TSImportType: check,
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
            if (
              node.name?.type === 'JSXIdentifier' &&
              node.name.name === 'button' &&
              solidFile(context.filename) &&
              !context.filename.endsWith('.test.solid.tsx')
            )
              context.report({
                node,
                message:
                  "The agent bridge sees only kit parts, so an agent can neither find nor press a bare <button>, and its click is recorded without a source. Use the kit's Button from @/components/ui (size={null} variant={null} for an unstyled one) with a name unique on the page.",
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
    'no-aria-pressed-button': {
      meta: { schema: [] },
      create(context: Context) {
        const buttons = new Set<string | undefined>()
        const triggers = new Set<string | undefined>()
        return {
          ImportDeclaration(node: Node) {
            const source = staticString(node.source)
            if (typeof source !== 'string') return
            const target = localModule(context.filename, source)
            const part = target && repositoryPath(target)
            for (const specifier of node.specifiers ?? []) {
              const imported = specifier.imported?.name
              if (part === 'web/src/components/ui/button.solid.tsx' && imported === 'Button')
                buttons.add(specifier.local?.name)
              if (
                (part === 'web/src/components/ui/tooltip.solid.tsx' &&
                  imported === 'TooltipTrigger') ||
                (part === 'web/src/components/ui/popover.solid.tsx' &&
                  imported === 'PopoverTrigger')
              )
                triggers.add(specifier.local?.name)
            }
          },
          JSXOpeningElement(node: Node & { name?: Node; attributes?: (Node & { name?: Node })[] }) {
            const pressed = node.attributes?.find((attr) => attr.name?.name === 'aria-pressed')
            const name = node.name?.name
            if (!pressed || !name) return
            if (!buttons.has(name)) {
              if (!triggers.has(name)) return
              const render = node.attributes?.find((attr) => attr.name?.name === 'render')
              const value = (render?.value as Node | undefined)?.expression
              const body = value?.body as (Node & { openingElement?: { name?: Node } }) | undefined
              const rendered = value?.name ?? body?.openingElement?.name?.name
              if (!rendered || !buttons.has(rendered)) return
            }
            context.report({
              node: pressed,
              message:
                'The agent bridge sees only press on a Button, never its pressed state. Use Toggle from @/components/ui/toggle.solid.tsx, or SegmentedControl or Tabs for a one-of-many selection.',
            })
          },
        }
      },
    },
    'no-raw-stream': {
      meta: { schema: [] },
      create(context: Context) {
        const why =
          'One stream to Ultimate keeps every page live and reconnecting, and runs each read once for all of them'
        const raw = `${why}: read state with useDoc/useDocOf and useAction, and call the server with api.action from @/sdk (docs/extensions/sdk.md), not fetch or a socket of your own to /api. Anything else, such as an external API or your surface's own backend, is yours to call.`
        const polled = `${why}: a timer that calls api.action or refetch polls once per page. Give useAction an \`every\` (the server runs the read and pushes changes) or an \`on\` that changes with what it reads (docs/extensions/sdk.md).`
        const toApi = (url: Node | undefined) => {
          const text =
            url?.type === 'Literal'
              ? url.value
              : url?.type === 'TemplateLiteral'
                ? (url as { quasis?: { value?: { raw?: string } }[] }).quasis?.[0]?.value?.raw
                : undefined
          return typeof text === 'string' && text.startsWith('/api')
        }
        const firstArgument = (node: Node) => node.arguments?.[0]
        const declarations = new WeakMap<Node, Map<string, Node>>()
        const declared = (node: Node) => {
          let program = node
          while (program.parent) program = program.parent
          let found = declarations.get(program)
          if (found) return found
          const named = new Map<string, Node>()
          walk(program, (child) => {
            if (child.type === 'FunctionDeclaration' && child.id?.name)
              named.set(child.id.name, child)
            if (child.type === 'VariableDeclarator' && child.id?.name && child.init)
              named.set(child.id.name, child.init)
            if (
              child.type === 'VariableDeclarator' &&
              child.id?.type === 'ObjectPattern' &&
              child.init
            )
              for (const property of child.id.properties ?? [])
                if (property.key?.name) named.set(property.key.name, child.init)
          })
          declarations.set(program, (found = named))
          return found
        }
        const sdkImports = (node: Node) => {
          let program = node
          while (program.parent) program = program.parent
          const localToImported = new Map<string, string>()
          for (const statement of (program.body as Node[] | undefined) ?? [])
            if (
              statement.type === 'ImportDeclaration' &&
              /^@\/sdk\/|\/web\/src\/sdk\//.test(String(statement.source?.value))
            )
              for (const specifier of statement.specifiers ?? [])
                if (specifier.imported?.name && specifier.local?.name)
                  localToImported.set(specifier.local.name, specifier.imported.name)
          return localToImported
        }
        const answerIsUsed = (call: Node): boolean => {
          const parent = call.parent
          if (parent?.type === 'MemberExpression') {
            const method = propertyName(parent)
            if (method === 'then') return true
            return method === 'catch' && !!parent.parent && answerIsUsed(parent.parent)
          }
          if (parent?.type === 'AwaitExpression') return answerIsUsed(parent)
          return parent?.type === 'VariableDeclarator' || parent?.type === 'AssignmentExpression'
        }
        const readsUltimate = (node: Node, named: Map<string, Node>, sdk: Map<string, string>) => {
          const resultOfUseAction = (identifier: Node) => {
            const init = named.get(identifier.name ?? '')
            return (
              init?.type === 'CallExpression' &&
              init.callee?.type === 'Identifier' &&
              sdk.get(init.callee.name ?? '') === 'useAction'
            )
          }
          const isSdkAction = (callee: Node | undefined) =>
            callee?.type === 'MemberExpression' &&
            callee.object?.type === 'Identifier' &&
            sdk.get(callee.object.name ?? '') === 'api' &&
            propertyName(callee) === 'action'
          if (node.type !== 'CallExpression') return false
          if ((node.arguments ?? []).some(isSdkAction)) return true
          if (isSdkAction(node.callee)) return answerIsUsed(node)
          const callee = node.callee
          if (callee?.type === 'MemberExpression' && propertyName(callee) === 'refetch')
            return callee.object?.type === 'Identifier' && resultOfUseAction(callee.object)
          if (callee?.type === 'Identifier' && callee.name === 'refetch')
            return resultOfUseAction(callee)
          return false
        }
        const reachesARead = (start: Node, named: Map<string, Node>, sdk: Map<string, string>) => {
          const seen = new Set<Node>()
          const queue = [start]
          const found: Node[] = []
          for (let next = queue.shift(); next && !found.length; next = queue.shift()) {
            if (seen.has(next)) continue
            seen.add(next)
            const declaration = next.type === 'Identifier' ? named.get(next.name ?? '') : undefined
            if (declaration) {
              queue.push(declaration)
              continue
            }
            walk(next, (child) => {
              if (readsUltimate(child, named, sdk)) found.push(child)
              else if (child.type === 'CallExpression' && child.callee?.type === 'Identifier')
                queue.push(child.callee)
            })
          }
          return found.length > 0
        }
        const callbackAt: Record<string, number> = {
          every: 1,
          retryAfter: 1,
          setInterval: 0,
          setTimeout: 0,
        }
        return {
          CallExpression(node: Node) {
            if (isGlobal(node.callee, 'fetch') && toApi(firstArgument(node)))
              context.report({ node, message: raw })
            const timer = node.callee?.type === 'Identifier' ? node.callee.name : undefined
            const at = timer === undefined ? undefined : callbackAt[timer]
            const callback = at === undefined ? undefined : node.arguments?.[at]
            if (callback && reachesARead(callback, declared(node), sdkImports(node)))
              context.report({ node, message: polled })
          },
          NewExpression(node: Node) {
            if (
              (isGlobal(node.callee, 'EventSource') || isGlobal(node.callee, 'WebSocket')) &&
              toApi(firstArgument(node))
            )
              context.report({ node, message: raw })
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
        const browser = context.filename.endsWith('.tsx')
        const allowed = browser ? ['refs.ts', 'ui.solid.tsx'] : ['api.ts']
        const how = browser
          ? 'its refs.ts (the refs of its documents and actions) or its ui.solid.tsx (its components, hooks and points)'
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
    'declared-requires': {
      meta: { schema: [] },
      create(context: Context) {
        const own = extensionOf(context.filename)
        const folder = extensionFolderOf(context.filename)
        if (!own || !folder || (coreExtension(own) && coreTier.test(apiText(folder)))) return {}
        const declared = declaredExtensions(apiText(folder), path.join(folder, 'api.ts'))
        const check = (node: ImportNode) => {
          const source = node.source?.value
          if (typeof source !== 'string' || !source.startsWith('.')) return
          if (node.importKind === 'type' || node.exportKind === 'type') return
          const target = resolved(context.filename, source)
          const [directory, extension, file] = target[0] === '.ultimate' ? target.slice(1) : target
          if (
            directory !== 'extensions' ||
            extension === own ||
            !['ui.solid.tsx', 'refs.ts'].includes(file) ||
            coreExtension(extension) ||
            declared.requires.includes(extension) ||
            declared.wants.includes(extension)
          )
            return
          context.report({
            node,
            message: `An optional extension can be turned off, and its browser code then runs without its server, so whatever uses it half-works with no word why. ${own} runs ${extension}'s browser code: declare it in ${folder}/api.ts, \`export const requires = ['${extension}']\` when ${own} cannot work without it (discovery then keeps ${own} off and says why), or \`export const wants = ['${extension}']\` when ${own} works without it and hides what needs it.`,
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
            if (file === 'ui.solid.tsx') return
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
              } else if (file === 'api.ts' && declarationOf(statement)) {
                if (!documented(context, statement))
                  report(
                    statement,
                    'Document each declaration: what the extension does with that extension.',
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
                    : "api.ts holds only contracts: imports, `export const X = defineApi/defineDoc/defineEntry(...)`, re-exports of its refs.ts (where event tokens live, for the browser too), types, `export const tier = 'core'` and the extensions it `requires` or `wants`.",
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
        if (!contract || contract.file === 'ui.solid.tsx') return {}
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
