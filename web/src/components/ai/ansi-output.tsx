import { ansiHtml } from './ansi.ts'

export function AnsiOutput({ output }: { output: string }) {
  return <span dangerouslySetInnerHTML={{ __html: ansiHtml(output) }} />
}
