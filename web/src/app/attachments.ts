export type AttachedFile = {
  name: string
  size: string
  mimeType: string
  path: string
  line?: string
}
export type DraftFile = AttachedFile & {
  id: string
  note?: string
  progress?: number
  image?: string
}
export type PastedImage = { data: string; mimeType: string; note?: string }

const plainTextAttachmentReference =
  /^Attached file: `([^`\n]+)` \(([^,\n]+), ([^)\n]+)\) at `([^`\n]+)`$/
const videoReference =
  /^Attached video: `([^`\n]+)` \(([^)\n]+)\), id `v_[a-f0-9]+`; ask about it with video_ask$/

export const attachmentLine = (file: AttachedFile) =>
  file.line ??
  `Attached file: \`${file.name}\` (${file.size}, ${file.mimeType || 'application/octet-stream'}) at \`${file.path}\``

export const attached = (file: AttachedFile) => !!(file.path || file.line)

export const uploadFor = <Upload extends { accepts?: string }>(
  uploads: readonly Upload[],
  mimeType: string,
) =>
  uploads.findLast((upload) => upload.accepts && mimeType.startsWith(upload.accepts)) ??
  uploads.findLast((upload) => !upload.accepts)

function parsed(entry: string): AttachedFile | undefined {
  const file = plainTextAttachmentReference.exec(entry)
  if (file) return { name: file[1], size: file[2], mimeType: file[3], path: file[4] }
  const video = videoReference.exec(entry)
  if (video) return { name: video[1], size: video[2], mimeType: 'video/', path: '', line: entry }
  return undefined
}

export function splitAttachments(text: string): { text: string; files: AttachedFile[] } {
  const files: AttachedFile[] = []
  const rest = text.split('\n').filter((entry) => {
    const file = parsed(entry)
    if (file) files.push(file)
    return !file
  })
  return files.length ? { text: rest.join('\n').trim(), files } : { text, files }
}

export function splitTrailingAttachments(value: string): { text: string; files: AttachedFile[] } {
  const lines = value.split('\n')
  let at = lines.length
  while (at > 0 && parsed(lines[at - 1])) at--
  if (at === lines.length || (at > 0 && lines[at - 1] !== '')) return { text: value, files: [] }
  const split = {
    text: at === 0 ? '' : lines.slice(0, at - 1).join('\n'),
    files: lines.slice(at).map((line) => parsed(line)!),
  }
  return withAttachments(split.text, split.files) === value ? split : { text: value, files: [] }
}

export const withAttachments = (text: string, files: readonly AttachedFile[]) =>
  [text, files.map(attachmentLine).join('\n')].filter(Boolean).join('\n\n')

export function uploadedAt(path: string): number | undefined {
  const uploadTimestampMsMatch = /\/attachments\/(\d{13})-[^/]+\/[^/]+$/.exec(path)
  return uploadTimestampMsMatch ? Number(uploadTimestampMsMatch[1]) : undefined
}
