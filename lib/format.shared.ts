const units = [
  [86400, 'd'],
  [3600, 'h'],
  [60, 'm'],
  [1, 's'],
] as const

export function formatDuration(ms: number): string {
  if (!(ms >= 1000)) return `${Math.max(0, Math.floor(ms))}ms`
  if (ms < 10_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`
  const seconds = Math.floor(ms / 1000)
  const index = units.findIndex(([size]) => seconds >= size)
  const [size, unit] = units[index]
  const major = `${Math.floor(seconds / size)}${unit}`
  const next = units[index + 1]
  const minor = next ? Math.floor((seconds % size) / next[0]) : 0
  return minor ? `${major} ${minor}${next[1]}` : major
}

export function formatAgo(at: number, now = Date.now(), { ago = false } = {}): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60000)
  const unit = (value: number, suffix: string) => `${value}${suffix}${ago ? ' ago' : ''}`
  if (minutes < 1) return ago ? 'just now' : 'now'
  if (minutes < 60) return unit(minutes, 'm')
  if (minutes < 60 * 24) return unit(Math.floor(minutes / 60), 'h')
  if (minutes < 60 * 24 * 7) return unit(Math.floor(minutes / 60 / 24), 'd')
  const date = new Date(at)
  return date.toLocaleDateString(
    undefined,
    date.getFullYear() === new Date(now).getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', year: '2-digit' },
  )
}
