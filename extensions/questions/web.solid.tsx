import { defineWebExtension, provide } from '@/sdk/solid'
import { MessageAnswers } from '../messages/ui.solid.tsx'
import { HiddenQuestionEntry, MessageQuestions } from './card.solid.tsx'
import { CrossSurfaceDraftSweep } from './sweep.solid.tsx'

export default defineWebExtension({
  slots: { overlay: [CrossSurfaceDraftSweep] },
  entries: {
    'questions.asked': HiddenQuestionEntry,
    'questions.answers': HiddenQuestionEntry,
  },
  commands: [
    {
      id: 'questions.open',
      title: 'Show open questions',
      run: (context) => context.openPanel('todos'),
    },
  ],
  provides: [provide(MessageAnswers, MessageQuestions)],
})
