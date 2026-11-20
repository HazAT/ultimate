import { ComposerPlaceholder, defineWebExtension, EmptyTranscript, island, provide } from '@/sdk'
import { SummaryModelDialog, summaryModelDialog } from './summary-model.solid.tsx'
import { useStandingEmpty, useStandingPlaceholder } from './standing.tsx'
import { HiddenIdentity, SummaryAction } from './summary-entry.solid.tsx'
import { MentionLink } from './mention.solid.tsx'

const summary = island(SummaryAction)

export default defineWebExtension({
  provides: [
    provide(ComposerPlaceholder, useStandingPlaceholder),
    provide(EmptyTranscript, useStandingEmpty),
  ],
  link: MentionLink,
  entries: {
    'conversations.identity': island(HiddenIdentity),
    'conversations.title-changed': summary,
    'conversations.feature-changed': summary,
    'conversations.intent-summarized': summary,
    'conversations.summarized': summary,
    'conversations.assessed': summary,
    'conversations.summary-discarded': summary,
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
