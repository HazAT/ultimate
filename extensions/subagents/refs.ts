/**
 * Subagents in the browser: the standing agents' conversations, and the actions that open a standing agent and read,
 * save and delete agent definitions. Browser-safe.
 */
import { actionRef, docRef } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'

/** Where a definition file lives: shipped with Ultimate, in the user's home, or in the project. */
export type Source = 'builtin' | 'user' | 'project'
/** Where a definition can be saved. */
export type Scope = 'user' | 'project'
/** A model as `provider` and `modelId`. */
export type ModelRef = { provider: string; modelId: string }
/** A parsed agent definition, without its instructions. */
export type Definition = {
  name: string
  description: string
  path: string
  source: Source
  model?: ModelRef
  thinking?: string
  /** The model family its file names (lib/families.ts). */
  family?: string
  /** What it runs on once the families apply: an assignment in settings, its pin, its family, else the default. */
  runs?: {
    family?: string
    model?: ModelRef
    thinking?: string
    via: 'assigned' | 'pin' | 'family'
  }
  tools?: string[]
  denyTools?: string[]
  isolate?: 'none' | 'worktree'
  resident?: boolean
  fast?: boolean
  summaries?: boolean
  /** Overlay files merged into it, in order; saving it writes an overlay, not a whole copy. */
  overlays?: string[]
}
/** A definition file that failed to parse, with the reason. */
export type Invalid = { name: string; path: string; source: Source; error: string }
/** What `start` can name, the files that failed to parse, and what the config form needs. */
export type Discovery = {
  definitions: Definition[]
  errors: Invalid[]
  /** The main conversation's model and tools; a definition may list a subset of the tools. */
  main: { model?: ModelRef; thinking?: string; tools: { name: string; description: string }[] }
  /** The folder each scope saves to. */
  scopes: Record<Scope, string>
  /** The user's choice on the project's `.ultimate/` setup; the project scope needs it trusted. */
  projectSetup: 'trusted' | 'declined' | 'undecided'
}
/** The definition of one name: the one that applies, a later file of that name that fails to parse, the raw file. */
export type Shown = {
  definition?: Definition & { instructions: string }
  invalid?: Invalid
  source: Source
  path: string
  raw: string
  /** The scopes with a file of this name, in the order they apply. */
  files: Source[]
}
/** The frontmatter `saveDefinition` writes; `model` is `provider/modelId`. */
export type DefinitionFields = {
  description: string
  model?: string
  thinking?: string
  family?: string
  tools?: string[]
  denyTools?: string[]
  isolate?: 'none' | 'worktree'
  resident?: boolean
  fast?: boolean
  summaries?: boolean
}

/**
 * Conversation `id` was configured to run as an agent: a subagent or automation run (`child`, `parent` the conversation
 * that owns it), a new standing agent's conversation (`standing`), or a branch (`branch`, `parent` the conversation it
 * forked from). `agent` is the definition or label, `model` `provider/modelId`. Emitted in the creating commit.
 */
export const Started = defineEvent<{
  id: number
  agent: string
  model?: string
  thinking?: string
  parent?: number
  kind: 'child' | 'standing' | 'branch'
}>('subagents.started')

/** `{ [name]: conversationId }` of the standing agents, on conversation 1. */
export const StandingDoc = docRef<Record<string, number>>('ultimate.standing-agents')

/** `{ name }` → the conversation id of standing agent `name`, created or refreshed from its definition. */
export const StandingAction = actionRef<{ name: string }, number>('subagents', 'standing')
/** No arguments → every definition, the files that failed to parse, and the main agent's model and tools. */
export const DefinitionsAction = actionRef<null, Discovery>('subagents', 'definitions')
/** `{ name }` → the definition that applies to `name`, its source and path, the raw file, and the scopes with one. */
export const DefinitionAction = actionRef<{ name: string }, Shown>('subagents', 'definition')
/**
 * `{ name, scope, frontmatter, instructions, create? }` → the saved definition: write `<scope>/agents/<name>.md`.
 * Invalid input writes nothing; with `create`, an existing definition of that name fails it.
 */
export const SaveDefinitionAction = actionRef<
  {
    name: string
    scope: Scope
    frontmatter: DefinitionFields
    instructions: string
    create?: boolean
  },
  Definition
>('subagents', 'saveDefinition')
/** `{ name, scope }` → `{ path }`: delete a user or project definition; another of that name applies again. */
export const DeleteDefinitionAction = actionRef<{ name: string; scope: Scope }, { path: string }>(
  'subagents',
  'deleteDefinition',
)
