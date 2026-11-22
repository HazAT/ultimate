import { join } from 'node:path'

export const webAliases = (ultimateRoot: string) => [
  { find: '@', replacement: join(ultimateRoot, 'web/src') },
]

export const webModule = (ultimateRoot: string, id: string) =>
  id.startsWith('@/') ? join(ultimateRoot, 'web/src', id.slice(2)) : id
