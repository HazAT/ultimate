/**
 * What a drag carries, without the DOM or React: the absolute path a drag hands over as text, and the base64 a `save`
 * action takes. `web.tsx` wires these to the composer.
 */

/** A dropped file is copied in only up to this size: base64 in a JSON action body, which stops at 12 MiB. */
export const maxDroppedBytes = 8 * 1024 * 1024

/**
 * The absolute path a drag handed over as text, or `undefined` when it handed over something else (a paragraph, a
 * URL). A drag of a file icon from Finder carries bytes and no path at all, so it lands here as `undefined` too.
 */
export function pathFromDrop(text: string): string | undefined {
  // `text/uri-list` is lines of URIs, `#` comments and CRLF; a plain text drag is the text.
  const first = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'))
  if (!first) return undefined
  if (first.startsWith('/')) return first
  const file = /^file:\/\/(?:localhost)?(\/.*)$/i.exec(first)
  if (!file) return undefined
  try {
    return decodeURIComponent(file[1])
  } catch {
    // A malformed escape is not a path this can decode; the drag then counts as handing over no path.
    return undefined
  }
}

/** `bytes` as base64, in chunks so a large file does not blow the argument limit of `String.fromCharCode`. */
export function base64FromBytes(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}
