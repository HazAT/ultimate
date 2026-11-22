import { ComposerPlaceholder, defineWebExtension, EmptyTranscript, provide } from '@/sdk/solid'
import { SummaryModelDialog, summaryModelDialog } from './summary-model.solid.tsx'
import { StandingEmpty } from './standing.solid.tsx'
import { standingPlaceholder } from './placeholder.solid.tsx'
import { HiddenIdentity, SummaryAction } from './summary-entry.solid.tsx'
import { MentionLink } from './mention.solid.tsx'

const summary = SummaryAction

export default defineWebExtension({
  provides: [
    provide(ComposerPlaceholder, standingPlaceholder),
    provide(EmptyTranscript, StandingEmpty),
  ],
  link: MentionLink,
  entries: {
    'conversations.identity': HiddenIdentity,
    'conversations.title-changed': summary,
    'conversations.feature-changed': summary,
    'conversations.intent-summarized': summary,
    'conversations.summarized': summary,
    'conversations.assessed': summary,
    'conversations.summary-discarded': summary,
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
