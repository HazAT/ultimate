import { createMemo, createSignal, For, Show } from 'solid-js'
import { highlight, plainLines } from '@/components/markdown/highlight.ts'
import type { Line } from '@/components/markdown/highlight.ts'
import { cn } from '@/sdk/solid'
import { Caret, useFollow } from './display.solid.tsx'

export function CodeBlock(props: {
  code: string
  language: string
  class: string
  lineNumbers?: boolean
  startLine?: number
  caret?: boolean
}) {
  const [loaded, setLoaded] = createSignal<{ code: string; language: string; lines: Line[] }>()
  const lines = createMemo(() => {
    const code = props.code.replace(/\n$/, '')
    const language = props.language
    const known = loaded()
    if (known?.code === code && known.language === language) return known.lines
    return (
      highlight(code, language, (ready) => setLoaded({ code, language, lines: ready })) ??
      plainLines(code)
    )
  })
  const start = () => props.startLine ?? 1
  const width = () => `${String(start() + lines().length - 1).length + 1}ch`
  const scroller = useFollow(
    () => !!props.caret,
    () => lines(),
  )
  return (
    <div
      class={cn('group relative w-full overflow-hidden rounded-md border bg-terminal', props.class)}
      data-language={props.language}
      ref={scroller}
    >
      <pre class="shiki m-0 overflow-auto px-3 py-2 font-mono text-[12px] leading-[1.6]">
        <code class="grid">
          <For each={lines()} keyed={false}>
            {(line, index) => {
              const caret = () => props.caret && index === lines().length - 1
              return (
                <span class="flex">
                  <Show when={props.lineNumbers}>
                    <span
                      class="sticky left-0 mr-3 shrink-0 bg-inherit pr-1 text-right text-muted-foreground/50 select-none"
                      style={{ width: width() }}
                    >
                      {start() + index}
                    </span>
                  </Show>
                  <span class="whitespace-pre">
                    <Show when={line().length} fallback={caret() ? '' : ' '}>
                      <For each={line()} keyed={false}>
                        {(token) => <span style={token().htmlStyle}>{token().content}</span>}
                      </For>
                    </Show>
                    <Show when={caret()}>
                      <Caret />
                    </Show>
                  </span>
                </span>
              )
            }}
          </For>
        </code>
      </pre>
    </div>
  )
}
