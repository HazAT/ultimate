export type AttachedFile = { name: string; size: string; mimeType: string; path: string }
export type DraftFile = AttachedFile & { id: string }
export type PastedImage = { data: string; mimeType: string; note?: string }

const plainTextAttachmentReference =
  /^Attached file: `([^`\n]+)` \(([^,\n]+), ([^)\n]+)\) at `([^`\n]+)`$/

export const attachmentLine = (file: AttachedFile) =>
  `Attached file: \`${file.name}\` (${file.size}, ${file.mimeType || 'application/octet-stream'}) at \`${file.path}\``

export function splitAttachments(text: string): { text: string; files: AttachedFile[] } {
  const files: AttachedFile[] = []
  const rest = text.split('\n').filter((entry) => {
    const match = plainTextAttachmentReference.exec(entry)
    if (match) files.push({ name: match[1], size: match[2], mimeType: match[3], path: match[4] })
    return !match
  })
  return files.length ? { text: rest.join('\n').trim(), files } : { text, files }
}

export const withAttachments = (text: string, files: readonly AttachedFile[]) =>
  [text, files.map(attachmentLine).join('\n')].filter(Boolean).join('\n\n')

export function uploadedAt(path: string): number | undefined {
  const uploadTimestampMsMatch = /\/attachments\/(\d{13})-[^/]+\/[^/]+$/.exec(path)
  return uploadTimestampMsMatch ? Number(uploadTimestampMsMatch[1]) : undefined
}
