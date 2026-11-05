/** One thing that happened in a root, newest first from the `recent` action, as its sidebar row lists it. */
export type RootEvent = {
  /** The root's entry it happened at. */
  entry: number
  at?: number
} & (
  | {
      type: 'landed'
      /** The full landed sha. */
      sha: string
      /** The target's tip it moved from, recorded since landings carry it. */
      base?: string
      /** How many commits it brought, merges included. */
      commits: number
      feature?: string
      title?: string
      from?: number
      /** How the work diverged from its task as given, as the landing recorded it (`None` when it matched). */
      divergence?: string
      /** `https://diffshub.com/<owner>/<repo>/compare/<base>...<sha>`, when `origin` is on GitHub. */
      compare?: string
    }
  | { type: 'note'; from?: number; text: string }
  | { type: 'branched'; branch: number; intent: string }
  | { type: 'compacted' }
  | { type: 'started' }
)
