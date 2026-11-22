import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  LoaderCircle,
} from '@lucide/solid'
import { dynamic } from '@solidjs/web'
import type { JSX } from '@solidjs/web'
import { cn } from 'cn'
import { Show } from 'solid-js'
import { fileChipClass, fileKind } from './file-kind.ts'

const icons = {
  image: FileImage,
  audio: FileAudio,
  video: FileVideo,
  archive: FileArchive,
  sheet: FileSpreadsheet,
  code: FileCode,
  text: FileText,
  file: File,
}

export function FileChip(props: {
  name: string
  mimeType: string
  note: string
  title?: string
  busy?: boolean
  gone?: boolean
  children?: JSX.Element
}) {
  const Icon = dynamic(() => icons[fileKind(props.name, props.mimeType)])
  return (
    <div
      class={cn(fileChipClass, props.gone && 'opacity-60')}
      data-ui="file-chip"
      title={props.title}
    >
      <div class="flex h-14 w-full items-center justify-center text-muted-foreground">
        <Show
          when={props.busy}
          fallback={<Icon aria-hidden="true" class="size-7" stroke-width={1.5} />}
        >
          <LoaderCircle aria-hidden="true" class="size-6 motion-safe:animate-spin" />
        </Show>
      </div>
      <p class="w-full truncate px-1 text-center text-[12px] leading-4 text-foreground/90">
        {props.name}
      </p>
      <p class="mt-0.5 w-full truncate pb-0.5 text-center text-[11px] leading-4 text-muted-foreground">
        {props.note}
      </p>
      {props.children}
    </div>
  )
}
