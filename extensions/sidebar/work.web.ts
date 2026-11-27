export type Work = {
  commits?: { count: number; spec: string }
  edits?: { count: number; spec: string }
}

export function workOf(
  id: number,
  branch: string | undefined,
  progress: { unlanded: number; uncommitted: number } | undefined,
): Work | undefined {
  if (!progress || !branch) return undefined
  const work: Work = {
    ...(progress.unlanded > 0 && {
      commits: { count: progress.unlanded, spec: `branch:${branch}` },
    }),
    ...(progress.uncommitted > 0 && {
      edits: { count: progress.uncommitted, spec: `uncommitted:${id}` },
    }),
  }
  return work.commits || work.edits ? work : undefined
}
