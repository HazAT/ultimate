import { ComposerPlaceholder, defineWebExtension, EmptyTranscript, island, provide } from '@/sdk'
import { SummaryModelDialog, summaryModelDialog } from './summary-model.solid.tsx'
import { useStandingEmpty, useStandingPlaceholder } from './standing.tsx'
import { SummaryAction } from './summary-entry.tsx'
import { MentionLink } from './mention.solid.tsx'

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
  slots: { overlay: [island(SummaryModelDialog)] },
  commands: [
    {
      id: 'conversations.summary-model',
      title: 'Summary model…',
      group: 'Conversations',
      run: (actions) => actions.open(summaryModelDialog),
    },
  ],
})
