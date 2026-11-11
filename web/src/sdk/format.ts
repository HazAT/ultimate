// Pi upstream: @earendil-works/pi-coding-agent@1.5.2 src/modes/interactive/components/footer.ts — copied formatTokens helper, not exported. Drop when Pi exports formatTokens.
/** Compact token counts, as Pi's footer prints them: 950, 1.2k, 18k, 1.4M. */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString()
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1000000) return `${Math.round(count / 1000)}k`
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`
  return `${Math.round(count / 1000000)}M`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

/** 420ms, 3.2s, 1m 04s, 2h 05m. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const seconds = Math.round(ms / 1000)
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}m`
}

/** How long ago a time was; in lib/ so server code (model text, range lists) says it the same way. */
export { formatAgo } from '../../../lib/ago.ts'

/** Show `path` relative to `cwd` when inside it, else with `~` for `home` (`system.machine.home`). */
export function shortenPath(path: string, options: { cwd?: string; home?: string } = {}): string {
  const { cwd, home } = options
  if (cwd && path.startsWith(cwd.replace(/\/$/, '') + '/'))
    return path.slice(cwd.replace(/\/$/, '').length + 1)
  if (home && (path === home || path.startsWith(home + '/'))) return '~' + path.slice(home.length)
  return path
}

/** Elide the middle of a path to at most `max` characters, keeping its first and last segments. */
export function elidePath(path: string, max = 40): string {
  if (path.length <= max) return path
  const parts = path.split('/')
  let head = parts.slice(0, parts[0] === '~' || parts[0] === '' ? 2 : 1).join('/')
  let tail = parts.at(-1) ?? ''
  for (let index = parts.length - 2; index > 1; index--) {
    const next = `${parts[index]}/${tail}`
    if (head.length + next.length + 2 > max) break
    tail = next
  }
  if (head.length + tail.length + 2 > max) head = head.slice(0, Math.max(1, max - tail.length - 2))
  return `${head}/…/${tail}`
}

/** `1 page`, `3 pages`: a count with its noun, plural by `s`. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** What to show for a thrown value: an Error's message, anything else as a string. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The app's one clock format, 24-hour: `21:45`, or `21:45:08` with seconds. */
export function formatTime(at: number | string | Date, seconds = false): string {
  return new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
    hourCycle: 'h23',
  })
}
