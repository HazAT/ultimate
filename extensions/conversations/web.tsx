import { BrandName, defineWebExtension, provide } from '@/sdk'
import { SummaryModelDialog, summaryModelDialog } from './dialogs.tsx'
import { SummaryAction } from './summary-entry.tsx'
import { MentionLink } from './mention.tsx'
import { useAgentTitle } from './marks.tsx'

export default defineWebExtension({
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
  // Core prints @ultimate's definition title where it would print ULTIMATE.
  provides: [
    provide(BrandName, () => {
      const { title, brand } = useAgentTitle('ultimate')
      return brand ? undefined : title
    }),
  ],
  commands: [
    {
      id: 'conversations.summary-model',
      title: 'Summary model…',
      group: 'Conversations',
      run: (actions) => actions.open(summaryModelDialog),
    },
  ],
})
