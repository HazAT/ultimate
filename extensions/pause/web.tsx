import { useMemo } from 'react'
import {
  ROOT,
  api,
  attention,
  defineWebExtension,
  getState,
  island,
  ParkedRuns,
  provide,
  useDocOf,
  useTasks,
} from '@/sdk'
import { AutoPlayedNote, Held, Limit, Note } from './entries.solid.tsx'
import { parkedConversations } from './parked.ts'
import { PauseAction, PauseDoc, PlayAction } from './refs.ts'
import { Hint, Item, Play } from './status.solid.tsx'

const paused = () => getState().docsOf[ROOT]?.[PauseDoc.kind]?.paused === true

function useParked() {
  const pausedNow = useDocOf(ROOT, PauseDoc)?.paused === true
  const graph = useTasks()
  return useMemo(() => parkedConversations(graph, pausedNow), [graph, pausedNow])
}

export default defineWebExtension({
  provides: [provide(ParkedRuns, useParked)],
  slots: {
    'statusline.right': [
      { component: island(Item), order: -3, phone: true },
      { component: island(Play), order: -3, phone: true },
    ],
    'composer.status': [island(Hint)],
  },
  entries: {
    'pause.note': island(Note),
    'pause.limit': attention(island(Limit)),
    'pause.autoplay': island(AutoPlayedNote),
    'pause.held': island(Held),
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
