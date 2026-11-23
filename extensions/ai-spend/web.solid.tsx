import { CoinsIcon } from '@lucide/solid'
import { Loading as LoadingBoundary, lazy } from 'solid-js'
import { defineWebExtension } from '@/sdk/solid'
import { SpendFrame, SpendTitle } from './ui/frame.solid.tsx'
import { Loading } from './ui/loading.solid.tsx'

const Surface = lazy(() => import('./ui/surface.solid.tsx'))

function SpendSurface() {
  return (
    <LoadingBoundary
      fallback={
        <SpendFrame header={<SpendTitle />}>
          <Loading />
        </SpendFrame>
      }
    >
      <Surface />
    </LoadingBoundary>
  )
}

export default defineWebExtension({
  surfaces: [
    {
      id: 'ai-spend',
      title: 'Spend',
      icon: CoinsIcon,
      description: 'Where the money went: by branch, agent, model and tool, with a forecast',
      order: 75,
      component: SpendSurface,
    },
  ],
  commands: [
    { id: 'ai-spend.open', title: 'Open Spend', run: (context) => context.showSurface('ai-spend') },
  ],
})
