/** @jsxImportSource @solidjs/web */
import { For } from 'solid-js'

export function Source(props: { code: string; language: string }) {
  return (
    <pre
      aria-label={`Script source (${props.language})`}
      class="px-3 py-2 leading-[1.55] text-foreground/85"
    >
      <code>
        <For each={props.code.split('\n')} keyed={false}>
          {(line, index) => (
            <span class="flex min-w-max gap-3">
              <span
                aria-hidden="true"
                class="w-6 shrink-0 text-right text-muted-foreground/60 tabular-nums select-none"
              >
                {index + 1}
              </span>
              <span>{line() || ' '}</span>
            </span>
          )}
        </For>
      </code>
    </pre>
  )
}
