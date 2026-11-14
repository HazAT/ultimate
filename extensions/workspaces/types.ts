import type { ConversationSubject } from '../conversations/types.ts'

export type Workspace = {
  path: string
  branch: string
  base: string
  source: string
  target: string
  state: 'preparing' | 'ready' | 'failed' | 'removed'
  error?: string
  landed?: string
}
/** One `workspace submit`, waiting for or being processed by its source's lander. */
export type QueueEntry = {
  id: string
  conversationId: number
  source: string
  target: string
  tip: string
  /** Latest submitting conversation entry when submit was called. */
  at: number
  divergence: string
  state: 'queued' | 'landing'
  subject?: ConversationSubject
  step?: string
  /** What the lander did so far, as its conversation logs it. */
  steps: LanderStep[]
  /** What its fast-forward landed: recorded with it, so any later lander task pushes and reports that. */
  landed?: Landed
}
/** A submission's landing: the target moved from `base` to `sha`, which brought `commits` and `paths`. */
export type Landed = {
  sha: string
  base: string
  commits: string[]
  paths: string[]
  flaky: string[]
  weight?: Weight
}
/** Lines and estimated tokens a landing added and removed over the files `lib/token-weight.ts` counts. */
export type Weight = { added: number; removed: number; tokens: number }
/** A check's result; a passed or flaky one carries its last output line as `summary`. */
export type LanderCheck = {
  command: string
  result: 'passed' | 'failed' | 'flaky'
  summary?: string
}
/** One row of a submission's progress: a step, or a check with its result. */
export type LanderStep = {
  step: string
  at: number
  /** The check command this step starts running; its `check` result row ends it. */
  runs?: string
  check?: LanderCheck
}
/** How a submission ended. A push that failed after landing locally is `landed` with a `reason`. */
export type LanderOutcome = {
  outcome: 'landed' | 'failed'
  divergence?: string
  sha?: string
  /** The target's tip the landing moved from: `base..sha` is what it brought. */
  base?: string
  commits?: string[]
  paths?: string[]
  flaky?: string[]
  weight?: Weight
  /** `<remote>/<target>` it was pushed to. */
  pushed?: string
  needsRestart?: boolean
  reason?: string
  /** Output tail behind the reason: conflicting paths, a check's output, git's error. */
  output?: string
  /** The failed check's whole output on the host, when `output` is its tail (`lander-logs/`, the newest 20 kept). */
  log?: string
  /** What the submitter does next, for a failure. */
  hint?: string
}
/** One line of a lander conversation's log (entry kind `ultimate.lander`): a step, a check result, or the outcome. */
export type LanderEntry = {
  submission: string
  conversationId: number
  tip: string
  target: string
  at: number
  /** Submitting conversation breadcrumb, not the log timestamp. */
  sourceEntry?: number
  step?: string
  runs?: string
  check?: LanderCheck
  /** On the submission's first line and its outcome. */
  subject?: ConversationSubject
} & Partial<LanderOutcome>
export type WorkspaceIndex = {
  items: Record<string, Workspace>
  queue: QueueEntry[]
  /** Live lander task per source checkout. */
  landers: Record<string, number>
  /** The lander conversation per source checkout, where its task runs and logs. */
  landerConversations: Record<string, number>
  /** Outcomes of the latest submissions by id, with their target and lander conversation, for the submitter's cards. */
  results: Record<
    string,
    LanderOutcome & {
      target: string
      tip: string
      lander: number
      steps: LanderStep[]
      conversationId?: number
      subject?: ConversationSubject
      at: number
      divergence: string
    }
  >
}
export type WorkspaceInfo = Workspace & {
  ahead: number | null
  tip: string | null
  sourceTip: string | null
  currentBranch: string | null
  sourceBranch: string | null
}
/** Checkouts by record state; ready ones by their commits (fresh: none of their own) and uncommitted changes. */
export type WorkspaceStats = Record<Workspace['state'], number> & {
  total: number
  landed: number
  ahead: number
  fresh: number
  dirty: number
}
/** Disk the worktrees directory takes: every checkout's blocks, and on btrfs the blocks they share counted once. */
export type WorkspaceDisk = { bytes: number | null; real: number | null; at: number }
export type LandResult = {
  text: string
  landed?: string
  commits?: string[]
  paths?: string[]
  files?: { path: string; added: number; removed: number }[]
  needsRestart?: boolean
}
export type SubmitResult = { text: string; id: string; position: number; lander: number }

/** A project's GitHub repository as the sidebar and the project rail name it. */
export type GithubRepo = {
  /** `github.com/<owner>/<repo>`, lowercased. */
  key: string
  /** `<owner>/<repo>` as GitHub spells it, or the key's when `gh` could not say. */
  name: string
  url: string
  /** Missing when `gh` is not installed, not signed in or cannot see the repository. */
  visibility?: 'public' | 'private' | 'internal'
}
