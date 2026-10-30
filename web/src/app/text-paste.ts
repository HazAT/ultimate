/**
 * A pasted block too big to keep inline: it stays in memory while its marker stands in the editor, as Pi's own editor
 * does it, and takes its place again on send. The block is never stored as a marker, so a reload restores the text.
 */
export type Paste = { id: number; text: string }

/** More lines, or more characters, than this fold: the composer holds a marker, a sent message a preview. */
export const foldLines = 8
export const foldChars = 800

/** Whether `text` is bigger than the composer keeps inline. */
export const overLimit = (text: string) =>
  text.length > foldChars || text.split('\n').length > foldLines

const markerSource = String.raw`\[paste #(\d+)(?: \+\d+ lines| \d+ chars)?\]`
const markers = new RegExp(markerSource, 'g')

const lines = (text: string) => text.split('\n').length

/** The marker standing in for `paste`: its lines, or its characters when it is one long line. */
export const pasteMarker = (paste: Paste) =>
  lines(paste.text) > 1
    ? `[paste #${paste.id} +${lines(paste.text)} lines]`
    : `[paste #${paste.id} ${paste.text.length} chars]`

/**
 * `text` with `block` standing in for the editor's selection `start..end` as paste number `pastes.length + 1`, and the
 * caret after its marker.
 */
export function insertPaste(
  text: string,
  start: number,
  end: number,
  block: string,
  pastes: readonly Paste[],
) {
  const paste = { id: pastes.length + 1, text: block }
  const marker = pasteMarker(paste)
  return {
    text: text.slice(0, start) + marker + text.slice(end),
    pastes: [...pastes, paste],
    caret: start + marker.length,
  }
}

/** `text` with every marker swapped back for its block, ready to send; an unknown marker stays as written. */
export function expandPastes(text: string, pastes: readonly Paste[]): string {
  if (pastes.length === 0) return text
  return text.replace(
    markers,
    (written, id: string) => pastes.find((paste) => paste.id === Number(id))?.text ?? written,
  )
}

/**
 * The editor after deleting at `caret`: a marker directly before it (backspace) or after it (delete) goes as one, so a
 * pasted block is removed whole, and the pastes after it take its number so they stay 1..n. Nothing to delete when the
 * caret touches no marker.
 */
export function deletePasteAt(
  text: string,
  caret: number,
  direction: 'backward' | 'forward',
  pastes: readonly Paste[],
) {
  const hit = [...text.matchAll(markers)].find((match) =>
    direction === 'backward' ? match.index + match[0].length === caret : match.index === caret,
  )
  const id = Number(hit?.[1])
  if (!hit || !pastes.some((paste) => paste.id === id)) return undefined
  return {
    text: text.replace(markers, (written, at: string) =>
      Number(at) === id
        ? ''
        : Number(at) > id
          ? written.replace(/#\d+/, `#${Number(at) - 1}`)
          : written,
    ),
    pastes: pastes
      .filter((paste) => paste.id !== id)
      .map((paste) => (paste.id > id ? { ...paste, id: paste.id - 1 } : paste)),
    caret: hit.index,
  }
}
