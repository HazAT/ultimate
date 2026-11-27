/**
 * Onboarding in the browser: the first run, the setup cards @ultimate shows while it gets familiar with a project,
 * and the actions behind them. Browser-safe.
 */
import type { ConversationId } from '@earendil-works/pi-durable'
import { actionRef, docRef } from '../../shared/extension-api.ts'
import type { ProjectSetup } from '../manager/refs.ts'
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
