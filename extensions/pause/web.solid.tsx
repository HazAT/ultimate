import { createMemo } from 'solid-js'
import {
  ROOT,
  api,
  attention,
  defineWebExtension,
  getState,
  ParkedRuns,
  provide,
  useDocOf,
  useTasks,
} from '@/sdk/solid'
import { AutoPlayedNote, Held, Limit, Note } from './entries.solid.tsx'
import { parkedConversations } from './parked.web.ts'
import { PauseAction, PauseDoc, PlayAction } from './refs.ts'
import { Hint, Item, Play } from './status.solid.tsx'

const paused = () => getState().docsOf[ROOT]?.[PauseDoc.kind]?.paused === true

function parked() {
  const pause = useDocOf(() => ROOT, PauseDoc)
  const graph = useTasks()
  return createMemo(() => parkedConversations(graph(), pause()?.paused === true))
}

export default defineWebExtension({
  provides: [provide(ParkedRuns, parked)],
  slots: {
    'statusline.right': [
      { component: Item, order: -3, phone: true },
      { component: Play, order: -3, phone: true },
    ],
    'composer.status': [Hint],
  },
  entries: {
    'pause.note': Note,
    'pause.limit': attention(Limit),
    'pause.autoplay': AutoPlayedNote,
    'pause.held': Held,
  },
  commands: [
    {
      id: 'pause.pause',
      title: 'Pause: stop starting new work',
      group: 'Ultimate',
      when: () => !paused(),
      run: () => api.action(PauseAction),
    },
    {
      id: 'pause.play',
      title: 'Play: continue paused work',
      group: 'Ultimate',
      when: paused,
      run: () => api.action(PlayAction),
    },
  ],
})
