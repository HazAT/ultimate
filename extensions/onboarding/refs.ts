/**
 * Onboarding in the browser: the first run, the setup cards @ultimate shows while it gets familiar with a project,
 * and the actions behind the Extensions panel. Browser-safe.
 */
import type { ConversationId } from '@earendil-works/pi-durable'
import { actionRef, docRef } from '../../shared/extension-api.ts'
import type { ExtensionInfo } from '../../shared/protocol.ts'

/** The project's own `.ultimate` setup: whether it has any, the user's decision on it (null: undecided), its README. */
export type ProjectSetup = { config: boolean; decision: boolean | null; readme?: string }
/** What the first run and the setup cards need. */
export type OnboardingStatus = {
  /** True until the user finished or skipped the first run. */
  firstRun: boolean
  /** `"onboarding": false` in `~/.ultimate/settings.json`: no first run, no Start here, no setup reminders but the project decision. */
  off: boolean
  project: ProjectSetup
  /** What `~/.ultimate/settings.json` enables and disables. */
  user: { enable: string[]; disable: string[] }
  /** What the project's setup would add: its agents, skills and extension folders, and the names it enables. */
  adds: {
    agents: string[]
    skills: string[]
    extensions: string[]
    replaces: string[]
    enable: string[]
    disable: string[]
  }
}
/** One extension as the Extensions panel lists it; `readme` is the first sentence of its README. */
export type Described = Pick<
  ExtensionInfo,
  'name' | 'source' | 'replaces' | 'enabled' | 'layer'
> & {
  readme: string
}

/**
 * `{ roots: { [root]: conversationId }, dismissed? }` on conversation 1: the onboarding conversation started for each
 * root, and whether the user dismissed the Start here card.
 */
export const StartsDoc = docRef<{ roots: Record<string, number>; dismissed?: boolean }>(
  'onboarding.starts',
)

/** No arguments → the first-run flag, the project's setup and what it would add, and the user's extension lists. */
export const StatusAction = actionRef<null, OnboardingStatus>('onboarding', 'status')
/** No arguments → `{ firstRun: false }`: record that the user finished or skipped the first run. */
export const FirstRunDoneAction = actionRef<null, { firstRun: boolean }>(
  'onboarding',
  'firstRunDone',
)
/**
 * `{ root?, instructions? }` → `{ id }`: start getting familiar with the project in @ultimate for root `root` (by
 * default the caller's), with the user's optional focus as `instructions`; `id` is @ultimate's conversation.
 */
export const StartAction = actionRef<
  { root?: ConversationId; instructions?: string },
  { id: ConversationId }
>('onboarding', 'start')
/** No arguments → `{ dismissed: true }`: hide the Start here card for this project; ⌘K Get ready… still starts setup. */
export const DismissAction = actionRef<null, { dismissed: boolean }>('onboarding', 'dismiss')
/** No arguments → `{ id }`: have @ultimate walk the user through how Ultimate works again, without project setup. */
export const WalkthroughAction = actionRef<null, { id: ConversationId }>(
  'onboarding',
  'walkthrough',
)
/** `{ card }` → `{ id }`: ask @ultimate for help with the project or Git card; `id` is @ultimate's conversation. */
export const HelpAction = actionRef<{ card: 'project' | 'git' }, { id: ConversationId }>(
  'onboarding',
  'help',
)
/**
 * `{ card, toolCallId, extensions | local | initialize }` → `{ sent: true }`: apply the user's choice on setup card
 * `toolCallId` (extension switches, the project decision, or whether to set up Git) and tell the conversation, once.
 */
export const ChooseAction = actionRef<
  {
    card: string
    toolCallId: string
    extensions?: Record<string, boolean>
    local?: boolean
    initialize?: boolean
  },
  { sent: boolean }
>('onboarding', 'choose')
/** `{ local }` → `{ project }`: decide whether this project's own setup applies. */
export const DecideAction = actionRef<{ local: boolean }, { project: ProjectSetup }>(
  'onboarding',
  'decide',
)
/**
 * `{ name, enabled, scope }` → `{ ok }`: turn extension `name` on or off in the user's or (once the project's setup is
 * chosen) the project's settings, then reload extensions.
 */
export const SetExtensionAction = actionRef<
  { name: string; enabled: boolean; scope: 'user' | 'project' },
  { ok: boolean }
>('onboarding', 'setExtension')
/** No arguments → `{ ok }`: copy the project's extension choices into the user's settings, then reload extensions. */
export const AdoptProjectSetupAction = actionRef<null, { ok: boolean }>(
  'onboarding',
  'adoptProjectSetup',
)
/** What the Extensions panel shows when a row opens: the contract and the dependencies the catalogue knows of. */
export type ExtensionDetails = {
  /** The first sentence of the api.ts or refs.ts doc comment; '' without either. */
  summary: string
  /** APIs and extension points it provides, and the points it declares for others. */
  provides: string[]
  declares: string[]
  needs: string[]
  wants: string[]
  /** Durable events its refs.ts defines. */
  events: string[]
}

/** `{ name }` → the loaded extension's contract summary, catalogue entries and events. */
export const DetailsAction = actionRef<{ name: string }, ExtensionDetails>('onboarding', 'details')
/** No arguments → every installed extension with its source, state and README line. */
export const ExtensionsAction = actionRef<null, Described[]>('onboarding', 'extensions')
