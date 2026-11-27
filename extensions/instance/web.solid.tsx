import { defineWebExtension, provide } from '@/sdk/solid'
import { PreviewUp } from '../sidebar/ui.solid.tsx'
import { InstanceCall } from './call.solid.tsx'
import { PreviewLink } from './link.solid.tsx'
import { Embedded, Poll, previewUp } from './overlays.solid.tsx'
import { canFrameLoopbackPreviews } from './previews.web.ts'
import { Switcher } from './switcher.solid.tsx'

export default defineWebExtension({
  provides: [provide(PreviewUp, previewUp)],
  tools: { instance: InstanceCall },
  link: PreviewLink,
  slots: {
    'titlebar.left': canFrameLoopbackPreviews ? [Switcher] : [],
    overlay: [Poll, Embedded],
  },
})
