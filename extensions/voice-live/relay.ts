export const QUIET_MS = 1200

export const TRAILING_MS = 2800
export const IDLE_MS = 120_000
export type LiveEvent = {
  type: string
  delta?: string
  session?: { expires_at?: number }
  usage?: { seconds: number }
  reason?: string
  [key: string]: unknown
}
export type RelayOut = { heard: string } | { log: { role: 'live'; text: string } }
const clean = (text: string) => text.trim().replace(/\s+/g, ' ')

const normalizeHeardGaps = (text: string) =>
  clean(text.replace(/\[(?:unintelligible|inaudible|indistinct)[^\]]*\]/gi, '…'))
    .replace(/(?:\s*(?:…|\.{2,}))+/g, ' …')
    .replace(/^[\s.…]+$/, '')
    .trim()
const endsSentence = (text: string) => /[.?!。？！]["')\]]*$/.test(text.trim())

export class Relay {
  private input = ''
  private inputAt?: number
  private output = ''
  private outputAt?: number
  private activityAt: number
  private commentaryAlreadyLogged = false
  private commentarySpokenText = ''

  constructor(now: number) {
    this.activityAt = now
  }

  spoke() {
    this.commentaryAlreadyLogged = true
    this.commentarySpokenText = ''
    this.output = ''
    this.outputAt = undefined
  }

  event(event: LiveEvent, now: number): RelayOut[] {
    const out = this.tick(now)
    if (event.type === 'session.input_transcript.delta' && event.delta) {
      this.input += event.delta
      this.inputAt = now
      this.activityAt = now
    } else if (event.type === 'session.output_transcript.delta' && event.delta) {
      if (this.commentaryAlreadyLogged) this.commentarySpokenText += event.delta
      else this.output += event.delta
      this.outputAt = now
      this.activityAt = now
    }

    return out
  }

  tick(now: number): RelayOut[] {
    const out: RelayOut[] = []
    const sentenceOrBreathQuietMs = endsSentence(this.input) ? QUIET_MS : TRAILING_MS
    if (this.inputAt !== undefined && now - this.inputAt >= sentenceOrBreathQuietMs) {
      const text = normalizeHeardGaps(this.input)
      this.input = ''
      this.inputAt = undefined
      this.commentaryAlreadyLogged = false
      if (text) out.push({ heard: text })
    }
    if (this.outputAt !== undefined && now - this.outputAt >= QUIET_MS) {
      const text = clean(this.output)
      this.output = ''
      this.outputAt = undefined
      if (text) out.push({ log: { role: 'live', text } })
    }
    return out
  }

  partial(): string {
    return this.inputAt === undefined ? '' : normalizeHeardGaps(this.input)
  }

  spokenWords(): number {
    return this.commentarySpokenText.split(/\s+/).filter(Boolean).length
  }

  hearing(): boolean {
    return this.inputAt !== undefined
  }

  talking(): boolean {
    return this.outputAt !== undefined
  }

  idleFor(now: number): number {
    return Math.max(0, now - this.activityAt)
  }
}
