import { FileDiffIcon } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { defineWebExtension, events, island, provide } from '@/sdk'
import { Review } from '../workspaces/ui.tsx'
import { ReviewCard } from './card.solid.tsx'
import { ReviewLink } from './link.solid.tsx'
import { Frame, Loading } from './parts.tsx'

const Viewer = lazy(() => import('./surface.tsx'))

function ReviewSurface() {
  return (
    <Suspense
      fallback={
        <Frame>
          <Loading />
        </Frame>
      }
    >
      <Viewer />
    </Suspense>
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
  slots: { overlay: [island(ReviewLink)] },
  entries: { 'review.comments': island(ReviewCard) },
  provides: [provide(Review, (spec) => () => events.emit('review:open', { spec }))],
})
