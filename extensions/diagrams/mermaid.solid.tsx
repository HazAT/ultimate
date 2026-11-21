/** @jsxImportSource @solidjs/web */
import { render } from 'lovely-mermaid'
import { createMemo, Show } from 'solid-js'
import type { CodeBlockRenderer } from '@/sdk/solid'

export const Mermaid: CodeBlockRenderer = (props) => {
  const art = createMemo(() => render(props.code))
  return (
    <Show when={!props.incomplete && art()} fallback={props.core}>
      {(diagram) => (
        <pre class="w-full overflow-x-auto rounded-md border bg-terminal p-3 font-mono text-xs leading-tight">
          {diagram().plain.join('\n')}
        </pre>
      )}
    </Show>
  )
}
