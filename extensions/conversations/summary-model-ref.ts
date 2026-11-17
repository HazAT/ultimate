import type { ModelThinkingLevel } from '@earendil-works/pi-ai'

const levels: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export function parseSummaryModel(value: string) {
  const colon = value.lastIndexOf(':')
  const recognizedThinkingSuffix =
    colon !== -1 && levels.includes(value.slice(colon + 1)) ? value.slice(colon + 1) : undefined
  const ref = recognizedThinkingSuffix ? value.slice(0, colon) : value
  const slash = ref.indexOf('/')
  if (slash <= 0 || slash === ref.length - 1 || /\s/.test(ref)) return undefined
  return {
    provider: ref.slice(0, slash),
    id: ref.slice(slash + 1),
    thinking: recognizedThinkingSuffix as ModelThinkingLevel | undefined,
  }
}
