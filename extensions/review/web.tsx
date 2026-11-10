import { FileDiffIcon } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { defineWebExtension, provide } from '@/sdk'
import { Review } from '../workspaces/ui.tsx'
import { ReviewCard } from './card.tsx'
import { openReview, ReviewLink } from './link.tsx'
import { Frame, Loading } from './parts.tsx'

// The diff viewer and its highlighter load with the surface, not with the app.
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
  messages: { ja: { Review: 'レビュー', 'Open Review': 'レビューを開く' } },
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
  provides: [provide(Review, (spec) => () => openReview(spec))],
})
