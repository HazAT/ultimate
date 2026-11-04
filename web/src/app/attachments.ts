/**
 * A file the composer uploaded to the host instead of sending it inline: the prompt carries one line naming its path.
 * `size` is as shown, such as `1.2 MB`.
 */
export type AttachedFile = { name: string; size: string; mimeType: string; path: string }

const line = /^Attached file: `([^`\n]+)` \(([^,\n]+), ([^)\n]+)\) at `([^`\n]+)`$/

/** The prompt line that references `file`: plain text, so it survives replay, compaction and merged steers as typed. */
export const attachmentLine = (file: AttachedFile) =>
  `Attached file: \`${file.name}\` (${file.size}, ${file.mimeType || 'application/octet-stream'}) at \`${file.path}\``

/** `text` with its attachment lines taken out as files, in order; text without them comes back as is. */
export function splitAttachments(text: string): { text: string; files: AttachedFile[] } {
  const files: AttachedFile[] = []
  const rest = text.split('\n').filter((entry) => {
    const match = line.exec(entry)
    if (match) files.push({ name: match[1], size: match[2], mimeType: match[3], path: match[4] })
    return !match
  })
  return files.length ? { text: rest.join('\n').trim(), files } : { text, files }
}

/** `text` followed by the lines referencing `files`, after a blank line when there is text. */
export const withAttachments = (text: string, files: readonly AttachedFile[]) =>
  [text, files.map(attachmentLine).join('\n')].filter(Boolean).join('\n\n')

/** When the host stored the file at `path` (its folder starts with the upload time in ms), or undefined. */
export function uploadedAt(path: string): number | undefined {
  const match = /\/attachments\/(\d{13})-[^/]+\/[^/]+$/.exec(path)
  return match ? Number(match[1]) : undefined
}
