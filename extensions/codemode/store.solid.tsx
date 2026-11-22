import { Show } from 'solid-js'
import { JsonTree } from '@/components/json-tree.solid.tsx'
import type { DocumentProps } from '@/sdk/solid'

export function StoreDocument(props: DocumentProps) {
  return (
    <Show
      when={Object.keys(props.value).length > 0}
      fallback={
        <p class="px-3 font-sans text-[12px] leading-relaxed text-muted-foreground/70">
          Empty. Codemode scripts keep values across runs with{' '}
          <code class="font-mono">store(key, value)</code> and read them with{' '}
          <code class="font-mono">load(key)</code>; they live with this conversation.
        </p>
      }
    >
      <JsonTree class="px-2" name="codemode store" open={1} value={props.value} />
    </Show>
  )
}
