import { defineWebExtension, island, provide } from '@/sdk'
import { MessageAnswers } from '../messages/ui.tsx'
import { HiddenQuestionEntry, MessageQuestions } from './card.solid.tsx'
import { CrossSurfaceDraftSweep } from './sweep.solid.tsx'

export default defineWebExtension({
  slots: { overlay: [island(CrossSurfaceDraftSweep)] },
  entries: {
    'questions.asked': island(HiddenQuestionEntry),
    'questions.answers': island(HiddenQuestionEntry),
  },
  commands: [
    {
      id: 'questions.open',
      title: 'Show open questions',
      run: (context) => context.openPanel('todos'),
    },
  ],
  provides: [provide(MessageAnswers, island(MessageQuestions))],
})
