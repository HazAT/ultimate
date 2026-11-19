export function lasted(ms: number) {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return `${Math.max(0, Math.round(ms / 1000))}s`
  const hours = Math.floor(minutes / 60)
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

export const unwrappedProviderError = (error: string) =>
  /upstream said: (.+)\)$/s.exec(error)?.[1] ??
  /"message"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(error)?.[1]?.replaceAll('\\"', '"') ??
  error
