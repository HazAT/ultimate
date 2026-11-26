export type Snap = 'folded' | 'rest' | 'full'
export type Variant = 'a' | 'b' | 'c'
export const VARIANTS: readonly Variant[] = ['a', 'b', 'c']
export const REST: Record<Variant, number> = { a: 0.5, b: 0.34, c: 0.6 }

const ORDER: readonly Snap[] = ['folded', 'rest', 'full']
const FLICK = 0.5

export function settle(
  variant: Variant,
  from: Snap,
  height: number,
  start: number,
  velocity: number,
  heights: Record<Snap, number>,
) {
  if (Math.abs(velocity) >= FLICK) {
    const up = velocity > 0
    if (variant === 'b') return up ? 'full' : 'folded'
    const at = ORDER.indexOf(from)
    return ORDER[Math.max(0, Math.min(2, at + (up ? 1 : -1)))]
  }
  if (Math.abs(height - start) < 24) return from
  return ORDER.reduce((best, snap) =>
    Math.abs(heights[snap] - height) < Math.abs(heights[best] - height) ? snap : best,
  )
}
