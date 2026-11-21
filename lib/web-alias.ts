import { join } from 'node:path'

const compatKit = 'ui/(?:button|checkbox|collapsible|command|dialog|dropdown-menu|kbd|popover|skeleton|switch|tooltip)|ai/(?:tool|message)'

/**
 * Where `@/…` resolves in browser code: `@/sdk` and the published React kit names (`@/components/ui/button`) to the
 * frozen React compat layer in `web/src/compat/`, which React facets outside the repository import; anything else
 * under `web/src`.
 */
export const webAliases = (ultimateRoot: string) => {
  const src = join(ultimateRoot, 'web/src')
  return [
    { find: /^@\/sdk$/, replacement: join(src, 'compat/sdk.ts') },
    {
      find: new RegExp(`^@/components/(${compatKit})$`),
      replacement: join(src, 'compat/$1.tsx'),
    },
    { find: '@', replacement: src },
  ]
}

/** The file `@/…` names under `webAliases`, for a resolver that runs before them (facets outside the repository). */
export const webModule = (ultimateRoot: string, id: string) => {
  for (const { find, replacement } of webAliases(ultimateRoot))
    if (typeof find === 'string' ? id.startsWith(find + '/') : find.test(id))
      return typeof find === 'string' ? replacement + id.slice(find.length) : id.replace(find, replacement)
  return id
}
