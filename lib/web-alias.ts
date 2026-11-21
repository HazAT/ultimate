import { join } from 'node:path'

const compatKit =
  'ui/(?:button|checkbox|collapsible|command|dialog|dropdown-menu|kbd|popover|skeleton|switch|tooltip)|ai/(?:tool|message)'

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

export const webModule = (ultimateRoot: string, id: string) => {
  for (const { find, replacement } of webAliases(ultimateRoot))
    if (typeof find === 'string' ? id.startsWith(find + '/') : find.test(id))
      return typeof find === 'string'
        ? replacement + id.slice(find.length)
        : id.replace(find, replacement)
  return id
}
