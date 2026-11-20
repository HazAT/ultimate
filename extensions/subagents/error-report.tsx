import { api, insertIntoComposer, useUltimate } from '@/sdk'
import { StandingAction } from './refs.ts'

export function useErrorReport() {
  const { switchConversation, showSurface, focusComposer } = useUltimate()
  return {
    title: 'Debug with @ultimate',
    send: (report: string) =>
      void api
        .action(StandingAction, { name: 'ultimate' })
        .then((id) => {
          insertIntoComposer(id, report)
          showSurface('agent')
          switchConversation(id)
          requestAnimationFrame(focusComposer)
        })
        .catch((error: unknown) => console.error('Could not open @ultimate', error)),
  }
}
