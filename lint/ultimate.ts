import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { apiSummary } from '../lib/api-files.ts'
import { coreTier } from '../shared/extension-api.ts'

interface ImportNode {
  source?: { value?: unknown }
  importKind?: string
  exportKind?: string
}

interface Node {
  type: string
  name?: string
  id?: Node
  specifiers?: { type?: string; imported?: Node }[]
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
  }
  report(diagnostic: { node: ImportNode | Node; message: string }): void
}

const extensionOf = (filename: string) => {
  const [directory, extension] = path.relative(process.cwd(), filename).split(path.sep)
  return directory === 'extensions' ? extension : undefined
}
/** The repository-relative path segments an import `source` of `filename` resolves to. */
const resolved = (filename: string, source: string) =>
  path.relative(process.cwd(), path.resolve(path.dirname(filename), source)).split(path.sep)
/**
 * An extension's contract files: `api.ts` for server code, `refs.ts` for the documents and actions the browser reads
 * and calls, `ui.tsx` for what other extensions' browser code imports.
 */
const contracts = ['api.ts', 'refs.ts', 'ui.tsx'] as const
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
const definers: Record<'api.ts' | 'refs.ts', Set<string>> = {
  'api.ts': new Set(['defineApi', 'defineDoc', 'defineEntry']),
  'refs.ts': new Set(['docRef', 'actionRef', 'defineEvent']),
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

export default {
  meta: { name: 'ultimate' },
  rules: {
    'no-raw-stream': {
      meta: { schema: [] },
      create(context: Context) {
        const message =
          'Extension UI reaches the server through @/sdk: useDoc/useDocOf and the other hooks for live state, useAction or api.action for server code (docs/extensions/sdk.md).'
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
                'Keep fast tests in-process and deterministic: use fake timers or test/e2e. A justified exception needs a fast-test-reason: comment.',
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
    'no-retired-ui': {
      meta: { schema: [] },
      create(context: Context) {
        return {
          Literal(node: Node) {
            if (
              typeof node.value === 'string' &&
              (/^(Branch from here|Clear context|New conversation)$/i.test(node.value) ||
                (node.value === 'board' &&
                  (node.parent?.key?.name ?? node.parent?.key?.value) === 'surface'))
            )
              context.report({
                node,
                message: 'Use the current conversation and surface vocabulary.',
              })
          },
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
                message: 'Use until from test/helpers.ts; it polls against a real deadline.',
              })
          },
        }
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
                  'AGENTS.md: Keep pnpm test fast; fix or delete a flaky test rather than raising its timeout. Do not override test timeouts.',
              })
          },
        }
      },
    },
    'replay-safe-reason': {
      meta: { schema: [] },
      create(context: Context) {
        return {
          Property(node: Node & { value: Node }) {
            if (
              (node.computed
                ? node.key?.value === 'replay'
                : (node.key?.name ?? node.key?.value) === 'replay') &&
              node.value.type === 'Literal' &&
              node.value.value === 'safe' &&
              !context.sourceCode.getCommentsBefore(node).length
            )
              context.report({
                node,
                message: 'Say why a rerun cannot do harm before declaring replay safe.',
              })
          },
        }
      },
    },
    'no-silent-catch': {
      meta: { schema: [] },
      create(context: Context) {
        // The reason may sit inside the handler, right before it, or above its statement.
        const statement = (node: Node) => {
          let current: Node | null | undefined = node
          while (current && !/(Statement|Declaration)$/.test(current.type)) current = current.parent
          return current
        }
        const check = (node: Node) => {
          const above = statement(node)
          if (
            !context.sourceCode.getCommentsBefore(node).length &&
            !context.sourceCode.getCommentsInside(node).length &&
            !(above && context.sourceCode.getCommentsBefore(above).length)
          )
            context.report({
              node,
              message: 'Say why ignoring the error is correct, or handle it.',
            })
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
            if (
              !handler ||
              !['ArrowFunctionExpression', 'FunctionExpression'].includes(handler.type)
            )
              return
            const body = handler.body as Node
            if (
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
              check(handler)
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
        // Server code reaches another extension through its api.ts, browser code through its ui.tsx.
        const browser = context.filename.endsWith('.tsx')
        const allowed = browser ? 'ui.tsx' : 'api.ts'
        const how = browser
          ? 'its ui.tsx (components, hooks and the refs of its documents and actions)'
          : 'its api.ts (a service, document or event token)'
        const check = (node: ImportNode) => {
          const source = node.source?.value
          if (typeof source !== 'string' || !source.startsWith('.')) return
          if (node.importKind === 'type' || node.exportKind === 'type') return
          const [directory, extension, ...file] = resolved(context.filename, source)
          if (directory === 'extensions' && extension !== own && file.join('/') !== allowed)
            context.report({
              node,
              message: `${own} imports ${extension}/${file.join('/')} at runtime; reach ${extension} through ${how}, import types with \`import type\`, or move a pure helper to lib/.`,
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
              message: `${own} is core tier and imports optional ${extension}; declare a point in ${own} that ${extension} provides, or react to an event.`,
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
        const report = (node: Node, message: string) => context.report({ node, message })
        const checkImport = (node: Node) => {
          const source = String(node.source?.value)
          if (source.startsWith('node:'))
            return report(node, `${file} is a contract: it imports no node:* module.`)
          const target = source.startsWith('.') ? resolved(context.filename, source) : undefined
          if (file === 'refs.ts') {
            // The browser imports refs.ts (tsconfig.web.json), so it may not reach server code even for types.
            if (node.importKind !== 'type')
              return target?.[0] === 'shared'
                ? undefined
                : report(
                    node,
                    'refs.ts imports at runtime only shared/; use `import type` for the rest.',
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
            if (file === 'ui.tsx') return
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
                    ? 'refs.ts holds only contracts: imports, `export const X = docRef/actionRef/defineEvent(...)` and types.'
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
        if (!contract || contract.file === 'ui.tsx') return {}
        const own = contract.extension
        return {
          CallExpression(node: Node) {
            const callee = node.callee
            const name = node.arguments?.[0]?.value
            if (callee?.type === 'Identifier' && callee.name === 'actionRef' && name !== own)
              context.report({
                node,
                message: `extensions/${own} refers only to its own actions: actionRef('${own}', name).`,
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
                message: `The API of extensions/${own} is named '${own}', its extension points '${own}.<point>'.`,
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
                message: `Events of extensions/${own} are named '${own}.<event>'.`,
              })
          },
        }
      },
    },
  },
}
