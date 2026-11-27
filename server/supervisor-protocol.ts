import { randomUUID } from 'node:crypto'
import { inProcess, settled } from '../lib/errors.shared.ts'
import type { BuildInfo } from '../shared/protocol.ts'

export type CoreReport =
  | { type: 'log'; level: 'info' | 'warn' | 'error'; source: string; text: string }
  | { type: 'web'; state: 'preparing' | 'ready' | 'stopped' }
  | { type: 'access'; origins: string[] }

export function reportCore(message: CoreReport) {
  if (process.send && process.connected) process.send(message, () => {})
}

export function isCoreReport(message: ChildMessage): message is CoreReport {
  const presentationOutsideLifecycleQueue =
    message.type === 'log' || message.type === 'web' || message.type === 'access'
  return presentationOutsideLifecycleQueue
}

export type ChildMessage =
  | CoreReport
  | { type: 'prepared'; port: number }
  | { type: 'ready' | 'released' }
  | { type: 'failed'; error: string }
  | { type: 'swap'; requestId: string; build?: BuildInfo }
  | { type: 'swap-ack'; requestId: string; ok: boolean; error?: string }
export type SupervisorMessage =
  | { type: 'go' | 'release' | 'exit' }
  | { type: 'reacquire'; error: string }
  | { type: 'swap-result'; requestId: string; ok: false; error: string }
  | { type: 'swap-result'; requestId: string; ok: true; generation: number }

export type HoldWebForSwap = () => { drained: Promise<void> | undefined; unhold: () => void }

const pendingSwaps = new Map<string, (error: string) => void>()
let acknowledgedSwap: ((error: string) => void) | undefined

export function settleReacquiredSwap(error: string) {
  acknowledgedSwap?.(error.slice(-4096))
}

export async function requestSwap(
  recordDurableReplayResult: (generation: number) => Promise<void>,
  build?: BuildInfo,
  holdWebForSwap?: HoldWebForSwap,
): Promise<string> {
  if (!process.send) return 'Restart requires pnpm start (the supervisor).'
  const requestId = randomUUID()
  return new Promise((resolve) => {
    let unholdWeb: (() => void) | undefined
    let recording: Promise<void> | undefined
    const finish = (error: string) => {
      pendingSwaps.delete(requestId)
      if (acknowledgedSwap === finish) acknowledgedSwap = undefined
      process.off('message', listener)
      unholdWeb?.()
      resolve(error)
    }
    const acknowledge = async (generation: number) => {
      try {
        const hold = holdWebForSwap?.()
        unholdWeb = hold?.unhold
        await hold?.drained
        if (!pendingSwaps.has(requestId)) return
        recording = recordDurableReplayResult(generation)
        await recording
      } catch (error) {
        if (!pendingSwaps.has(requestId)) return
        process.send?.({
          type: 'swap-ack',
          requestId,
          ok: false,
          error: String(error),
        } satisfies ChildMessage)
        finish(String(error))
        return
      }
      if (pendingSwaps.has(requestId)) {
        acknowledgedSwap = finish
        process.send?.({ type: 'swap-ack', requestId, ok: true } satisfies ChildMessage)
      }
    }
    const listener = (message: SupervisorMessage) => {
      if (message.type !== 'swap-result' || message.requestId !== requestId) return
      if (!message.ok) {
        const error = message.error.slice(-4096)
        if (!recording) return finish(error)
        pendingSwaps.delete(requestId)
        return inProcess(
          'a refusal settles the swap once its approval has finished writing',
          settled(recording).then(() => finish(error)),
        )
      }
      inProcess(
        'the swap acknowledgement belongs to this process and its supervisor channel',
        acknowledge(message.generation),
      )
    }
    pendingSwaps.set(requestId, finish)
    process.on('message', listener)
    process.send?.({ type: 'swap', requestId, build } satisfies ChildMessage)
  })
}
