import { api, insertIntoComposer, useUltimate, writerNow, writingAs } from '@/sdk'
import { StandingAction } from './refs.ts'

export function useErrorReport() {
  const { switchConversation, showSurface, focusComposer } = useUltimate()
  return {
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
}
