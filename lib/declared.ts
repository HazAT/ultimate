import { parseSync } from 'vite-plus'

type Node = {
  type: string
  exportKind?: string
  specifiers?: { exportKind?: string; exported?: { name?: string; value?: unknown } }[]
  value?: unknown
  expression?: Node
  elements?: (Node | null)[]
  declaration?: Node | null
  declarations?: { id?: { name?: string }; init?: Node | null }[]
}

export type Declared = { requires: string[]; wants: string[] }

const unwrapped = (node: Node): Node =>
  ['TSAsExpression', 'TSSatisfiesExpression'].includes(node.type)
    ? unwrapped(node.expression!)
    : node

export function declaredExtensions(apiText: string, file = 'api.ts'): Declared {
  const found: Declared = { requires: [], wants: [] }
  if (!/\b(requires|wants)\b/.test(apiText)) return found
  const { program, errors } = parseSync(file, apiText) as unknown as {
    program: { body: Node[] }
    errors: { message: string }[]
  }
  if (errors.length) throw new Error(`${file}: ${errors[0].message}`)
  for (const statement of program.body) {
    if (statement.type !== 'ExportNamedDeclaration' || statement.exportKind === 'type') continue
    for (const specifier of statement.specifiers ?? []) {
      if (specifier.exportKind === 'type') continue
      const exported = specifier.exported?.name ?? specifier.exported?.value
      if (exported === 'requires' || exported === 'wants')
        throw new Error(
          `${file}: declare ${exported} as \`export const ${exported} = [...]\`, not through another export`,
        )
    }
    for (const declarator of statement.declaration?.declarations ?? []) {
      const name = declarator.id?.name
      if (name !== 'requires' && name !== 'wants') continue
      const list = declarator.init && unwrapped(declarator.init)
      const names = list?.type === 'ArrayExpression' ? list.elements : undefined
      if (
        !names?.every((element) => element?.type === 'Literal' && typeof element.value === 'string')
      )
        throw new Error(
          `${file}: export const ${name} must be an array of extension names as string literals`,
        )
      found[name] = names.map((element) => element!.value as string)
    }
  }
  return found
}
