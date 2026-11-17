export const onboarded = (
  started: number | undefined,
  memories: { memories: Record<string, unknown> } | null,
) => {
  if (started !== undefined) return true
  const hasPriorSetupMemories = Object.keys(memories?.memories ?? {}).length > 0
  return hasPriorSetupMemories
}
