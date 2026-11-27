import { randomUUID } from 'node:crypto'
import { inProcess } from '../lib/errors.shared.ts'
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
  | { type: 'reacquire'; requestId: string; error: string }
  | { type: 'swap-result'; requestId: string; ok: false; error: string }
  | { type: 'swap-result'; requestId: string; ok: true; generation: number }

export async function requestSwap(
  recordDurableReplayResult: (generation: number) => Promise<void>,
  build?: BuildInfo,
): Promise<string> {
  if (!process.send) return 'Restart requires pnpm start (the supervisor).'
  const requestId = randomUUID()
  return new Promise((resolve) => {
    const finish = (error: string) => {
      process.off('message', listener)
      resolve(error)
    }
    const listener = (message: SupervisorMessage) => {
      if (
        (message.type !== 'swap-result' && message.type !== 'reacquire') ||
        message.requestId !== requestId
      )
        return
      if (message.type === 'reacquire' || !message.ok) return finish(message.error.slice(-4096))
      inProcess(
        'the swap acknowledgement belongs to this process and its supervisor channel',
        recordDurableReplayResult(message.generation).then(
          () => {
            process.send?.({ type: 'swap-ack', requestId, ok: true } satisfies ChildMessage)
          },
          (error) => {
            process.send?.({
              type: 'swap-ack',
              requestId,
              ok: false,
              error: String(error),
            } satisfies ChildMessage)
            finish(String(error))
          },
        ),
      )
    }
    process.on('message', listener)
    process.send?.({ type: 'swap', requestId, build } satisfies ChildMessage)
  })
}
