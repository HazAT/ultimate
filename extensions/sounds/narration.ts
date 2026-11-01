import type { Cue, Sound } from './cues.ts'

/** A spoken line, and the notification sound that leads into it; without `text` the sound alone (Finished). */
export type Line = { text?: string; sound: Sound }

const words = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine']
/** "Three branches", or "12 branches". */
const count = (n: number, noun: string) => `${words[n - 2] ?? n} ${noun}`
/** "a", "a and b", "a, b, and c". */
const list = (names: string[]) =>
  names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`

/** What each sound says, for one cue or several that arrived together. Finished has no line: its sound says it. */
const say: Partial<Record<Sound, (cues: Cue[]) => string>> = {
  input: (cues) => {
    if (cues.length > 1) return `${count(cues.length, 'questions')} for you.`
    const [{ subject }] = cues
    return subject ? `${subject} needs your answer.` : 'Ultimate has a question.'
  },
  failed: () => 'Ultimate stopped with an error.',
  landed: (cues) => {
    const names = cues.flatMap((cue) => (cue.subject ? [cue.subject] : []))
    if (cues.length === 1) return names.length ? `Landed: ${names[0]}.` : 'Work landed.'
    if (cues.length > 3 || names.length < cues.length)
      return `${count(cues.length, 'branches')} landed.`
    return `${count(cues.length, 'branches')} landed: ${list(names)}.`
  },
  started: (cues) =>
    cues.length === 1 && cues[0].subject
      ? `Started: ${cues[0].subject}.`
      : `${count(cues.length, 'new branches')} started.`,
}

/** Questions first, then failures, landings, new branches and finished answers. */
const order: Sound[] = ['input', 'failed', 'landed', 'started', 'finished']

/** The lines for `cues` that arrived together: one per kind, so three landings become one line. */
export function linesOf(cues: readonly Cue[]): Line[] {
  return order.flatMap((sound) => {
    const of = cues.filter((cue) => cue.sound === sound)
    if (!of.length) return []
    const text = say[sound]?.(of)
    return [text ? { text, sound } : { sound }]
  })
}

/** A title fit to speak: its first line, at most about eight words. */
export function spoken(title: string | undefined) {
  const line = title
    ?.split('\n')[0]
    .trim()
    .replace(/[.:]+$/, '')
  if (!line) return undefined
  const parts = line.split(/\s+/)
  return parts.length > 8 ? `${parts.slice(0, 8).join(' ')}…` : line
}
