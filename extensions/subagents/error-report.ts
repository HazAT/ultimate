import { api } from '../../web/src/sdk/client.ts'
import { actions } from '../../web/src/sdk/actions.ts'
import { insertIntoComposer } from '../../web/src/app/drafts.ts'
import { writerNow, writingAs } from '../../web/src/sdk/writer.ts'
import { StandingAction } from './refs.ts'

/** Hands an error card's report to @ultimate's composer, unsent, and shows it. */
export const errorReport = {
  title: 'Debug with @ultimate',
  send: (report: string) => {
    const who = writerNow()
    void writingAs(who, () => api.action(StandingAction, { name: 'ultimate' }))
      .then((id) =>
        writingAs(who, () => {
          insertIntoComposer(id, report)
          actions.showSurface('agent')
          actions.switchConversation(id)
          requestAnimationFrame(actions.focusComposer)
        }),
      )
      .catch((error: unknown) => console.error('Could not open @ultimate', error))
  },
}
