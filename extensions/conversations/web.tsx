import { ComposerPlaceholder, defineWebExtension, EmptyTranscript, provide } from '@/sdk'
import { SummaryModelDialog, summaryModelDialog } from './dialogs.tsx'
import { useStandingEmpty, useStandingPlaceholder } from './standing.tsx'
import { SummaryAction } from './summary-entry.tsx'
import { MentionLink } from './mention.tsx'

export default defineWebExtension({
  provides: [
    provide(ComposerPlaceholder, useStandingPlaceholder),
    provide(EmptyTranscript, useStandingEmpty),
  ],
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
