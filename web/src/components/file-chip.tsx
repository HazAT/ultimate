import { cn } from 'cn'
import {
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  LoaderCircleIcon,
} from 'lucide-react'
import { createElement } from 'react'
import type { ReactNode } from 'react'

/** The icon for a file by its MIME type and name: what kind of thing it is, at a glance. */
function icon(name: string, mimeType: string) {
  const extension = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? ''
  if (mimeType.startsWith('image/')) return FileImageIcon
  if (mimeType.startsWith('audio/')) return FileAudioIcon
  if (mimeType.startsWith('video/')) return FileVideoIcon
  if (
    /zip|tar|gzip|compressed|7z|rar/.test(mimeType) ||
    /^(zip|tgz|gz|tar|7z|rar)$/.test(extension)
  )
    return FileArchiveIcon
  if (/csv|spreadsheet|excel/.test(mimeType) || /^(csv|xlsx?|ods|numbers)$/.test(extension))
    return FileSpreadsheetIcon
  if (/json|javascript|typescript|xml|x-sh|x-python/.test(mimeType)) return FileCodeIcon
  if (
    mimeType === 'application/pdf' ||
    mimeType.startsWith('text/') ||
    /word|document/.test(mimeType)
  )
    return FileTextIcon
  return FileIcon
}

/** A short type label: the file's extension in capitals (`PDF`, `ZIP`), else its MIME subtype. */
export function typeLabel(name: string, mimeType: string) {
  const extension = /\.([^.]{1,6})$/.exec(name)?.[1]
  if (extension) return extension.toUpperCase()
  return (mimeType.split('/')[1] ?? 'file').toUpperCase().slice(0, 8)
}

/**
 * A file attachment, in the same bordered box as an attached image: a type icon, the name, and a centred note
 * (`1.2 MB · PDF`, `Uploading…`). `children` goes on top, such as the composer's remove button.
 */
export function FileChip({
  name,
  mimeType,
  note,
  title,
  busy,
  gone,
  className,
  children,
}: {
  name: string
  mimeType: string
  note: string
  title?: string
  busy?: boolean
  gone?: boolean
  className?: string
  children?: ReactNode
}) {
  return (
    <div
      className={cn(
        'relative flex w-38 flex-col items-center rounded-md border border-border/80 bg-terminal p-1',
        gone && 'opacity-60',
        className,
      )}
      data-ui="file-chip"
      title={title}
    >
      <div className="flex h-14 w-full items-center justify-center text-muted-foreground">
        {busy ? (
          <LoaderCircleIcon className="size-6 motion-safe:animate-spin" />
        ) : (
          createElement(icon(name, mimeType), { className: 'size-7', strokeWidth: 1.5 })
        )}
      </div>
      <p className="w-full truncate px-1 text-center text-[12px] leading-4 text-foreground/90">
        {name}
      </p>
      <p className="mt-0.5 w-full truncate pb-0.5 text-center text-[11px] leading-4 text-muted-foreground">
        {note}
      </p>
      {children}
    </div>
  )
}
