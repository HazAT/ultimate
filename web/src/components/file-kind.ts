export type FileKind = 'image' | 'audio' | 'video' | 'archive' | 'sheet' | 'code' | 'text' | 'file'

export function fileKind(name: string, mimeType: string): FileKind {
  const extension = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? ''
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType.startsWith('video/')) return 'video'
  if (
    /zip|tar|gzip|compressed|7z|rar/.test(mimeType) ||
    /^(zip|tgz|gz|tar|7z|rar)$/.test(extension)
  )
    return 'archive'
  if (/csv|spreadsheet|excel/.test(mimeType) || /^(csv|xlsx?|ods|numbers)$/.test(extension))
    return 'sheet'
  if (/json|javascript|typescript|xml|x-sh|x-python/.test(mimeType)) return 'code'
  if (
    mimeType === 'application/pdf' ||
    mimeType.startsWith('text/') ||
    /word|document/.test(mimeType)
  )
    return 'text'
  return 'file'
}

export function typeLabel(name: string, mimeType: string) {
  const extension = /\.([^.]{1,6})$/.exec(name)?.[1]
  if (extension) return extension.toUpperCase()
  return (mimeType.split('/')[1] ?? 'file').toUpperCase().slice(0, 8)
}

export const fileChipClass =
  'relative flex w-38 flex-col items-center rounded-md border border-border/80 bg-terminal p-1'
