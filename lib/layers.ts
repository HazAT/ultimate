/** Which changed paths (from the repository root) a running Ultimate cannot hot-reload (AGENTS.md "Layers and how they reload"). */

/** `server/` or `shared/`: the core, loaded once per process. */
export const corePath = (path: string) => /^(server|shared)\//.test(path)

/** `pnpm-lock.yaml` or `patches/`: installed packages. A patch's hash sits in the lockfile, so either one owes an install. */
export const packagePath = (path: string) =>
  path === 'pnpm-lock.yaml' || path.startsWith('patches/')

/**
 * Whether a change to `paths` needs a restart of the Ultimates running from that clone: the core and the packages a
 * process already imported stay loaded, whatever is on disk.
 */
export const needsRestart = (paths: readonly string[]) =>
  paths.some((path) => corePath(path) || packagePath(path))
