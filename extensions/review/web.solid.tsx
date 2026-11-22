import { FileDiffIcon } from '@lucide/solid'
import { Loading as LoadingBoundary, lazy } from 'solid-js'
import { defineWebExtension, events, provide } from '@/sdk/solid'
import { Review } from '../workspaces/ui.solid.tsx'
import { ReviewCard } from './card.solid.tsx'
import { ReviewLink } from './link.solid.tsx'
import { Frame, Loading } from './parts.solid.tsx'

const Viewer = lazy(() => import('./surface.solid.tsx'))

function ReviewSurface() {
  return (
    <LoadingBoundary
      fallback={
        <Frame>
          <Loading />
        </Frame>
      }
    >
      <Viewer />
    </LoadingBoundary>
  )
}

export default defineWebExtension({
  surfaces: [
    {
      id: 'review',
      title: 'Review',
      icon: FileDiffIcon,
      description: 'Local diffs: uncommitted changes, commits, branches and landings',
      order: 60,
      component: ReviewSurface,
    },
  ],
  commands: [
    { id: 'review.open', title: 'Open Review', run: (context) => context.showSurface('review') },
  ],
  slots: { overlay: [ReviewLink] },
  entries: { 'review.comments': ReviewCard },
  provides: [provide(Review, (spec) => () => () => events.emit('review:open', { spec: spec() }))],
})
