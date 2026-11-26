import { AnsiOutput } from '@/components/ai/ansi-output.solid.tsx'
import { Tool, ToolContent, ToolHeader, ToolSection } from '@/components/ai/tool.solid.tsx'
import { renderEntry } from '@/sdk/solid'
import { BackgroundEndedEntry } from './refs.ts'

export const BackgroundEnded = renderEntry(BackgroundEndedEntry, (props) => {
  const data = () => props.entry.data
  const ok = () => data().exitCode === 0
  const exit = () => (data().signal ? data().signal : `exit ${data().exitCode}`)
  const firstLine = () => data().command.split('\n')[0]
  return (
    <Tool data-background-ended={data().pgid}>
      <ToolHeader
        aria-label={`Background group ${data().pgid} ended: ${firstLine()}`}
        meta={
          <>
            <span>ended</span>
            <span class={ok() ? undefined : 'text-error'}>{exit()}</span>
          </>
        }
        name="&"
        state={ok() ? 'done' : 'error'}
        title={
          <span class="text-foreground/90" title={firstLine()}>
            {firstLine()}
          </span>
        }
      />
      <ToolContent>
        <ToolSection class="truncate text-muted-foreground/70" title={data().log}>
          {data().log}
        </ToolSection>
        <pre class="max-h-80 overflow-auto bg-terminal px-3 py-2 leading-[1.55] whitespace-pre-wrap text-foreground/85">
          <AnsiOutput output={data().tail || 'no output'} />
        </pre>
      </ToolContent>
    </Tool>
  )
})
