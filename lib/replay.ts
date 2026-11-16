export const readOnly = { replay: 'safe' } as const

export const safeToRerun = (why: string) => {
  if (!why.trim()) throw new Error('safeToRerun needs why a rerun does no harm')
  return { replay: 'safe' } as const
}
