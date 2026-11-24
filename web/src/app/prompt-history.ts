import { keepLast } from '../../../lib/errors.ts'

const key = 'ultimate.prompt-history'
const limit = 500

export type Browse = { typed: string; at: number; shown: string }

export function readHistory(storage: Pick<Storage, 'getItem'> = localStorage): string[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

export function remembered(history: readonly string[], prompt: string): string[] {
  const text = prompt.trim()
  if (!text) return [...history]
  return [...history.filter((item) => item !== text), text].slice(-limit)
}

export function rememberPrompt(prompt: string, storage: Storage = localStorage) {
  try {
    storage.setItem(key, JSON.stringify(remembered(readHistory(storage), prompt)))
  } catch (error) {
    keepLast(error)
  }
}

export function older(
  history: readonly string[],
  browse: Browse | undefined,
  current: string,
): Browse | undefined {
  const typed = browse?.typed ?? current
  const from = browse?.at ?? history.length
  for (let at = from - 1; at >= 0; at--) {
    const item = history[at]
    if (item.startsWith(typed) && item !== current) return { typed, at, shown: item }
  }
  return undefined
}

export function newer(
  history: readonly string[],
  browse: Browse,
  current: string,
): Browse | undefined {
  for (let at = browse.at + 1; at < history.length; at++) {
    const item = history[at]
    if (item.startsWith(browse.typed) && item !== current)
      return { typed: browse.typed, at, shown: item }
  }
  return { typed: browse.typed, at: history.length, shown: browse.typed }
}

export const atLastLine = (value: string, caret: number) => !value.slice(caret).includes('\n')
