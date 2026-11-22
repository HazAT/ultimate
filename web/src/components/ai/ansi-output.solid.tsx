import { createEffect } from 'solid-js'
import { ansiHtml } from '@/components/ai/ansi.ts'

export function AnsiOutput(props: { output: string }) {
  let span: HTMLSpanElement | undefined
  createEffect(
    () => props.output,
    (output) => {
      if (span) span.innerHTML = ansiHtml(output)
    },
  )
  return <span ref={span} />
}
