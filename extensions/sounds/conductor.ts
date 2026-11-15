import { deadline } from '../../lib/timers.ts'
import type { Cancel } from '../../lib/timers.ts'
import { demo, demoLength, demoPlayer } from './agents.tsx'
import type { Happening, Variant } from './agents.tsx'
import type { Band } from './engine.ts'
import { engine } from './tones.ts'

export type Stage = {
  variant?: Variant
  blocked: boolean
  demoUntil?: number
}

let stage: Stage = { blocked: false }
let band: Band | undefined
let cancels: Cancel[] = []
const listeners = new Set<() => void>()

const set = (next: Partial<Stage>) => {
  stage = { ...stage, ...next }
  for (const listener of listeners) listener()
}
export const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
export const current = () => stage

async function resumeAudioAfterGesture() {
  const { unlock, running } = await engine()
  await unlock()
  if (running()) set({ blocked: false })
}
function waitForGesture() {
  const once = () => {
    for (const type of ['pointerdown', 'keydown'] as const) removeEventListener(type, once, true)
    resumeAudioAfterGesture().catch((error: unknown) => console.warn('Audio start failed', error))
  }
  for (const type of ['pointerdown', 'keydown'] as const)
    addEventListener(type, once, { capture: true })
}

export async function conduct(variant: Variant | undefined) {
  if (variant === stage.variant) return
  band?.dispose()
  band = undefined
  if (!variant) {
    stopDemo()
    set({ variant: undefined, blocked: false })
    return
  }
  set({ variant })
  const tone = await engine()

  const variantSuperseded = stage.variant !== variant
  if (variantSuperseded) return

  const browserNeedsAudioGesture = !navigator.userActivation.hasBeenActive
  if (browserNeedsAudioGesture) {
    set({ blocked: true })
    waitForGesture()
  } else await tone.unlock()
  band = tone.band(variant)
}

export const hit = (happening: Happening) => {
  const tabVisible = !document.hidden
  if (tabVisible) band?.hit(happening)
}

export function startDemo() {
  stopDemo()
  const step = demoPlayer()
  cancels = demo.map((s) =>
    deadline(s.at * 1000, () => {
      const happening = step(s)
      if (happening) hit(happening)
    }),
  )
  cancels.push(deadline(demoLength * 1000, stopDemo))
  set({ demoUntil: Date.now() + demoLength * 1000 })
}
export function stopDemo() {
  for (const cancel of cancels) cancel()
  cancels = []
  if (stage.demoUntil !== undefined) set({ demoUntil: undefined })
}
