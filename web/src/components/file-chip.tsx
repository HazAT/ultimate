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
import { fileChipClass, fileKind } from './file-kind.ts'

export { typeLabel } from './file-kind.ts'

const icons = {
  image: FileImageIcon,
  audio: FileAudioIcon,
  video: FileVideoIcon,
  archive: FileArchiveIcon,
  sheet: FileSpreadsheetIcon,
  code: FileCodeIcon,
  text: FileTextIcon,
  file: FileIcon,
}

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
      className={cn(fileChipClass, gone && 'opacity-60', className)}
      data-ui="file-chip"
      title={title}
    >
      <div className="flex h-14 w-full items-center justify-center text-muted-foreground">
        {busy ? (
          <LoaderCircleIcon className="size-6 motion-safe:animate-spin" />
        ) : (
          createElement(icons[fileKind(name, mimeType)], { className: 'size-7', strokeWidth: 1.5 })
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
