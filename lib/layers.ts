export const corePath = (path: string) => /^(server|shared)\//.test(path)

export const packagePath = (path: string) =>
  path === 'pnpm-lock.yaml' || path.startsWith('patches/')

export const needsRestart = (paths: readonly string[]) =>
  paths.some((path) => corePath(path) || packagePath(path))
