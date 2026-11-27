import type { Message } from '../messages/refs.ts'
import type { OverviewRow } from '../conversations/types.ts'

export type Sound = 'input' | 'finished' | 'failed' | 'landed' | 'started'

export const sounds: { sound: Sound; label: string }[] = [
  { sound: 'input', label: 'Needs input' },
  { sound: 'finished', label: 'Finished' },
  { sound: 'failed', label: 'Failed' },
  { sound: 'landed', label: 'Landed' },
]

export type Cue = { key: string; sound: Sound; subject?: string }

export type Watched = {
  agent?: number
  row?: OverviewRow
  messages: readonly Pick<Message, 'id' | 'from' | 'to' | 'reply'>[]
  landings?: readonly { id: number; title?: string }[]
  branches?: readonly { id: number; title?: string }[]
  title?: (id: number) => string | undefined
}

export function cuesOf({
  agent,
  row,
  messages,
  landings = [],
  branches = [],
  title,
}: Watched): Cue[] {
  if (agent === undefined) return []
  const cues = messages
    .filter((message) => message.to === 'user' && (message.reply || message.from === agent))
    .map((message): Cue => {
      const subject =
        typeof message.from === 'number' && message.from !== agent
          ? title?.(message.from)
          : undefined
      return {
        key: `message:${message.id}`,
        sound: message.reply ? 'input' : 'finished',
        ...(subject ? { subject } : {}),
      }
    })
  if (row?.runState === 'error' && row.inputId !== undefined)
    cues.push({ key: `${agent}:${row.inputId}`, sound: 'failed' })
  else if (row?.runState === 'answered' && row.answerId !== undefined && !row.internalInput)
    cues.push({ key: `${agent}:${row.answerId}`, sound: 'finished' })
  for (const landing of landings)
    cues.push({ key: `landed:${landing.id}`, sound: 'landed', subject: landing.title })
  for (const branch of branches)
    cues.push({ key: `branch:${branch.id}`, sound: 'started', subject: branch.title })
  return cues
}

export function listener() {
  let heardCueKeys: Set<string> | undefined
  return (watched: Watched, catchingUp = false) => {
    const cues = cuesOf(watched)
    if (!heardCueKeys) {
      heardCueKeys = new Set(cues.map((cue) => cue.key))
      return []
    }
    const newCues = cues.filter((cue) => !heardCueKeys!.has(cue.key))
    for (const cue of newCues) heardCueKeys.add(cue.key)
    return catchingUp
      ? newCues.filter((cue) => cue.sound !== 'landed' && cue.sound !== 'started')
      : newCues
  }
}
