import { createEffect, onCleanup } from 'solid-js'
import { createHighlight } from './highlight.web.ts'
import type { SpokenText } from './highlight.web.ts'
import { speech } from './voice.solid.tsx'

const highlight = createHighlight(speech)

export function useSpokenText(
  elements: () => readonly Element[],
  spoken: () => SpokenText | undefined,
) {
  let tracked: ReturnType<typeof highlight.track> | undefined
  createEffect(spoken, (now) => {
    if (!now && !tracked) return
    tracked ??= highlight.track(elements)
    tracked.update(now)
  })
  onCleanup(() => tracked?.dispose())
}
