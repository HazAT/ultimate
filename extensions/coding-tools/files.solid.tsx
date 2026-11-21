/** @jsxImportSource @solidjs/web */
import { createMemo, createSignal, Match, Show, Switch, untrack } from 'solid-js'
import { Shimmer } from '@/components/ai/shimmer.solid.tsx'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolImage,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool.solid.tsx'
import { languageFromPath } from '@/components/markdown/highlight.ts'
import { useToolDuration, formatBytes, type SolidToolProps } from '@/sdk/solid'
import { CodeBlock } from './code.solid.tsx'
import { Diff } from './diff.solid.tsx'
import { countChanges, editRows, rowsFromDetails } from './diff.ts'
import { text, usePath } from './display.solid.tsx'

function lineCount(value: string) {
  if (!value) return 0
  return value.split('\n').length - (value.endsWith('\n') ? 1 : 0)
}
const lines = (count: number) => `${count} line${count === 1 ? '' : 's'}`

function skillOf(path: string) {
  const parts = path.split('/')
  return parts.at(-1) === 'SKILL.md' && parts.length > 1 ? parts.at(-2) : undefined
}

export function Read(props: SolidToolProps) {
  const path = () => text(props.call.args.path)
  const shown = usePath(path)
  const skill = createMemo(() => skillOf(path()))
  const duration = useToolDuration(() => props.call)
  const offset = () =>
    typeof props.call.args.offset === 'number' ? props.call.args.offset : undefined
  const limit = () =>
    typeof props.call.args.limit === 'number' ? props.call.args.limit : undefined
  const range = () => {
    const from = offset()
    const length = limit()
    return from || length ? `:${from ?? 1}${length ? `-${(from ?? 1) + length - 1}` : '+'}` : ''
  }
  const failed = () => props.call.status === 'error'
  const count = createMemo(() => (props.call.status === 'done' ? lineCount(props.call.output) : 0))
  const image = () => props.call.images[0]
  const diagnostics = createMemo(() =>
    image()
      ? props.call.diagnostics.filter((d) => !/^Read image file \[[^\]]+\]\.$/.test(d.message))
      : props.call.diagnostics,
  )
  return (
    <Tool defaultOpen={failed() || !!image()}>
      <ToolHeader
        aria-label={`Read call ${props.call.id}: ${shown()}`}
        meta={
          <>
            <Show when={count() > 0}>
              <span>{lines(count())}</span>
            </Show>
            <Show when={duration()}>
              <span>{duration()}</span>
            </Show>
          </>
        }
        name={skill() ? 'skill' : 'read'}
        state={props.call.status}
        title={
          <Show
            when={skill()}
            fallback={
              <>
                {shown()}
                <span class="text-muted-foreground/60">{range()}</span>
              </>
            }
          >
            <span class="text-brand">{skill()}</span>
            <span class="text-muted-foreground/60"> · {shown()}</span>
          </Show>
        }
      />
      <ToolContent>
        <Switch>
          <Match when={failed()}>
            <ToolOutput isError output={props.call.output} />
          </Match>
          <Match when={image()}>
            {(result) => (
              <ToolSection>
                <ToolImage alt={`${shown()} (call ${props.call.id})`} image={result()} />
              </ToolSection>
            )}
          </Match>
          <Match when={props.call.output}>
            <CodeBlock
              class="max-h-96 overflow-auto rounded-none border-none"
              code={props.call.output}
              language={languageFromPath(path())}
              lineNumbers
              startLine={offset() ?? 1}
            />
          </Match>
        </Switch>
        <ToolDiagnostics diagnostics={diagnostics()} />
      </ToolContent>
    </Tool>
  )
}

function FileTitle(props: { path: string; verb: string }) {
  const shown = usePath(() => props.path)
  return (
    <Show when={props.path} fallback={<Shimmer>{`${props.verb}…`}</Shimmer>}>
      {shown()}
    </Show>
  )
}

export function Write(props: SolidToolProps) {
  const path = () => text(props.call.args.path)
  const content = () => text(props.call.args.content)
  const duration = useToolDuration(() => props.call)
  const failed = () => props.call.status === 'error'
  const streaming = () => props.call.status === 'streaming'
  const streamedOnMount = untrack(streaming)
  const [toggled, setToggled] = createSignal<boolean>()
  const size = createMemo(() =>
    streaming() ? '' : ` · ${formatBytes(new TextEncoder().encode(content()).length)}`,
  )
  return (
    <Tool
      onOpenChange={setToggled}
      open={toggled() ?? (streamedOnMount || streaming() || failed())}
    >
      <ToolHeader
        aria-label={`Write call ${props.call.id}: ${path()}`}
        meta={
          <>
            <Show when={content()}>
              <span>
                {lines(lineCount(content()))}
                {size()}
              </span>
            </Show>
            <Show when={duration()}>
              <span>{duration()}</span>
            </Show>
          </>
        }
        name="write"
        state={props.call.status}
        title={<FileTitle path={path()} verb="writing" />}
      />
      <ToolContent>
        <Show when={content()}>
          <CodeBlock
            caret={streaming()}
            class="max-h-96 overflow-auto rounded-none border-none"
            code={content()}
            language={languageFromPath(path())}
            lineNumbers
          />
        </Show>
        <Show when={failed()}>
          <ToolOutput isError output={props.call.output} />
        </Show>
        <ToolDiagnostics diagnostics={props.call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}

export function Edit(props: SolidToolProps) {
  const path = () => text(props.call.args.path)
  const duration = useToolDuration(() => props.call)
  const streaming = () => props.call.status === 'streaming'
  const rows = createMemo(() => {
    const result = rowsFromDetails(props.call.details)
    if (result) return result
    const args = props.call.args
    return editRows(
      Array.isArray(args.edits)
        ? (args.edits as { oldText?: string; newText?: string }[])
        : [{ oldText: text(args.oldText), newText: text(args.newText) }],
    )
  })
  const changes = createMemo(() => {
    if (streaming()) return undefined
    const counts = countChanges(rows())
    return counts.added || counts.removed ? counts : undefined
  })
  return (
    <Tool defaultOpen>
      <ToolHeader
        aria-label={`Edit call ${props.call.id}: ${path()}`}
        meta={
          <>
            <Show when={changes()}>
              {(counts) => (
                <span>
                  <span class="text-diff-add">+{counts().added}</span>{' '}
                  <span class="text-diff-del">−{counts().removed}</span>
                </span>
              )}
            </Show>
            <Show when={duration()}>
              <span>{duration()}</span>
            </Show>
          </>
        }
        name="edit"
        state={props.call.status}
        title={<FileTitle path={path()} verb="editing" />}
      />
      <ToolContent>
        <Show
          when={props.call.status !== 'error'}
          fallback={<ToolOutput isError output={props.call.output} />}
        >
          <Diff caret={streaming()} class="max-h-[28rem]" rows={rows()} />
        </Show>
        <ToolDiagnostics diagnostics={props.call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}

function fileLine(verb: string) {
  return function FileLine(props: Pick<SolidToolProps, 'call'>) {
    const shown = usePath(() => text(props.call.args.path))
    return (
      <>
        <span class="text-foreground/80">{verb}</span> {shown()}
      </>
    )
  }
}

export const WriteLine = fileLine('write')
export const EditLine = fileLine('edit')

export function ReadLine(props: Pick<SolidToolProps, 'call'>) {
  const path = () => text(props.call.args.path)
  const shown = usePath(path)
  return (
    <Show
      when={skillOf(path())}
      fallback={
        <>
          <span class="text-foreground/80">read</span> {shown()}
        </>
      }
    >
      {(skill) => (
        <>
          <span class="text-foreground/80">skill</span> <span class="text-brand">{skill()}</span>
        </>
      )}
    </Show>
  )
}
