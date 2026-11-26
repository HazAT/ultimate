export type Snap = 'folded' | 'rest' | 'full'
export const REST = 0.5

const ORDER: readonly Snap[] = ['folded', 'rest', 'full']

export function settle(
  from: Snap,
  height: number,
  start: number,
  velocity: number,
  heights: Record<Snap, number>,
): Snap {
  if (Math.abs(velocity) >= 0.5) return velocity > 0 ? 'full' : 'folded'
  if (Math.abs(height - start) < 24) return from
  return ORDER.reduce((best, snap) =>
    Math.abs(heights[snap] - height) < Math.abs(heights[best] - height) ? snap : best,
  )
}
