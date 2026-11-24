export type AttachedFile = { name: string; size: string; mimeType: string; path: string }
export type DraftFile = AttachedFile & { id: string }
export type PastedImage = { data: string; mimeType: string; note?: string }

const plainTextAttachmentReference =
  /^Attached file: `([^`\n]+)` \(([^,\n]+), ([^)\n]+)\) at `([^`\n]+)`$/

export const attachmentLine = (file: AttachedFile) =>
  `Attached file: \`${file.name}\` (${file.size}, ${file.mimeType || 'application/octet-stream'}) at \`${file.path}\``

function attachmentOf(line: string): AttachedFile | undefined {
  const match = plainTextAttachmentReference.exec(line)
  return match ? { name: match[1], size: match[2], mimeType: match[3], path: match[4] } : undefined
}

export function splitAttachments(text: string): { text: string; files: AttachedFile[] } {
  const files: AttachedFile[] = []
  const rest = text.split('\n').filter((entry) => {
    const file = attachmentOf(entry)
    if (file) files.push(file)
    return !file
  })
  return files.length ? { text: rest.join('\n').trim(), files } : { text, files }
}

export function splitTrailingAttachments(value: string): { text: string; files: AttachedFile[] } {
  const lines = value.split('\n')
  let at = lines.length
  while (at > 0 && attachmentOf(lines[at - 1])) at--
  if (at === lines.length || (at > 0 && lines[at - 1] !== '')) return { text: value, files: [] }
  return {
    text: at === 0 ? '' : lines.slice(0, at - 1).join('\n'),
    files: lines.slice(at).map((line) => attachmentOf(line)!),
  }
}

export const withAttachments = (text: string, files: readonly AttachedFile[]) =>
  [text, files.map(attachmentLine).join('\n')].filter(Boolean).join('\n\n')

export function uploadedAt(path: string): number | undefined {
  const uploadTimestampMsMatch = /\/attachments\/(\d{13})-[^/]+\/[^/]+$/.exec(path)
  return uploadTimestampMsMatch ? Number(uploadTimestampMsMatch[1]) : undefined
}
