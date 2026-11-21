/** @jsxImportSource @solidjs/web */
import {
  api,
  focusComposer,
  insertIntoComposer,
  showSurface,
  switchConversation,
  writerNow,
  writingAs,
} from '@/sdk/solid'
import { StandingAction } from './refs.ts'

export const errorReport = {
  title: 'Debug with @ultimate',
  send: (report: string) => {
    const who = writerNow()
    void writingAs(who, () => api.action(StandingAction, { name: 'ultimate' }))
      .then((id) =>
        writingAs(who, () => {
          insertIntoComposer(id, report)
          showSurface('agent')
          switchConversation(id)
          requestAnimationFrame(focusComposer)
        }),
      )
      .catch((error: unknown) => console.error('Could not open @ultimate', error))
  },
}
