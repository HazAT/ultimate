import { ComposerPlaceholder, defineWebExtension, provide } from '@/sdk'
import { SummaryModelDialog, summaryModelDialog } from './dialogs.tsx'
import { useStandingName } from './feature.tsx'
import { standingPlaceholder, useAgentTitle } from './marks.tsx'
import { SummaryAction } from './summary-entry.tsx'
import { MentionLink } from './mention.tsx'

function useStandingPlaceholder({ conversation, busy }: { conversation: number; busy: boolean }) {
  // The standing name is the `@name` address; definitions and marks know it without the `@`.
  const name = useStandingName(conversation)?.replace(/^@/, '')
  return standingPlaceholder(name, useAgentTitle(name ?? '').title, busy)
}

export default defineWebExtension({
  provides: [provide(ComposerPlaceholder, useStandingPlaceholder)],
  link: MentionLink,
  entries: {
    'conversations.identity': () => null,
    'conversations.title-changed': SummaryAction,
    'conversations.feature-changed': SummaryAction,
    'conversations.intent-summarized': SummaryAction,
    'conversations.summarized': SummaryAction,
    'conversations.assessed': SummaryAction,
    'conversations.summary-discarded': SummaryAction,
  },
  slots: { overlay: [SummaryModelDialog] },
  commands: [
    {
      id: 'conversations.summary-model',
      title: 'Summary model…',
      group: 'Conversations',
      run: (actions) => actions.open(summaryModelDialog),
    },
  ],
})
