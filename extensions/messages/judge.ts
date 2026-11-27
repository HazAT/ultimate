import type { ExtensionHost } from '../../server/extensions.ts'
import { within } from '../../lib/timers.shared.ts'
import { Judge } from './api.ts'
import type { JudgeService } from './api.ts'

const JUDGE_TIMEOUT_MS = 10_000

class JudgeTimeout extends Error {}

export async function judge(
  host: ExtensionHost,
  question: (service: JudgeService, signal: AbortSignal) => Promise<number>,
  signal: AbortSignal,
): Promise<{ p: number } | { error: string }> {
  const service = host.want(Judge)
  if (!service) return { error: 'no judge' }
  const stop = new AbortController()
  try {
    const cancelled = new Promise<never>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    )
    const p = await within(
      JUDGE_TIMEOUT_MS,
      Promise.race([question(service, AbortSignal.any([signal, stop.signal])), cancelled]),
      () => new JudgeTimeout(),
      signal,
    )
    if (!Number.isFinite(p) || p < 0 || p > 1) return { error: 'invalid verdict' }
    return { p }
  } catch (error) {
    if (signal.aborted) throw error
    if (error instanceof JudgeTimeout) return { error: 'timed out' }
    return { error: error instanceof Error ? error.message.slice(0, 80) : 'judge failed' }
  } finally {
    stop.abort()
  }
}
