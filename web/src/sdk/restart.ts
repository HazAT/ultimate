import type { SystemInfo } from '../../../shared/protocol.ts'

export type RestartPhase =
  | { phase: 'idle'; error?: string }
  | { phase: 'asking' }
  | { phase: 'swapping'; target: number; systemAtStreamDrop?: object }

export function restartPhase(
  current: RestartPhase,
  system: SystemInfo | undefined,
  open: boolean,
): RestartPhase {
  if (current.phase !== 'swapping') return current
  const serving = system?.process.generation ?? 0
  if (serving >= current.target) return { phase: 'idle' }
  if (!open && !current.systemAtStreamDrop) return { ...current, systemAtStreamDrop: system ?? {} }
  if (current.systemAtStreamDrop && open && system && system !== current.systemAtStreamDrop)
    return {
      phase: 'idle',
      error: `Generation ${current.target} failed to activate and was rolled back; generation ${serving} keeps serving. The reason is in the supervisor's output.`,
    }
  return current
}

export const restartTimedOut = (target: number, timeoutMs: number): RestartPhase => ({
  phase: 'idle',
  error: `Generation ${target} did not start serving within ${Math.round(timeoutMs / 1000)} s.`,
})

export const restartAccepted = (result: unknown): RestartPhase => {
  const target = (result as { generation?: number } | undefined)?.generation
  return target === undefined ? { phase: 'idle' } : { phase: 'swapping', target }
}
