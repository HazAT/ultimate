// Pi upstream: @earendil-works/pi-durable@1.5.2 src/tools/bash.ts and src/tools/edit.ts — internal bash exit_code diagnostic message drives exitOf and untyped details.patch/details.diff drive Edit. Drop when Pi exports structured bash outcomes and structured diff rows for rendering.
import { XIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnsiOutput } from '@/components/ai/ansi-output'
import { Shimmer } from '@/components/ai/shimmer'
import { CodeBlock, languageFromPath } from '@/components/ai/code-block'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolImage,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool'
import {
  api,
  cn,
  defineWebExtension,
  formatBytes,
  shortenPath,
  useConversation,
  useStore,
  useToolDuration,
} from '@/sdk'
import type { ToolCallView } from '@/sdk'
import { type BashStep, formatBashCommand } from './bash-command.tsx'
import { countChanges, Diff, editRows, parseDisplayDiff, parsePatch } from './diff.tsx'
import { CancelAction } from './refs.ts'

const text = (value: unknown) => (typeof value === 'string' ? value : '')

/** A path relative to the conversation's cwd, else with `~`. */
function usePath(path: string) {
  const cwd = useConversation((conversation) => conversation.agent.cwd)
  const defaultCwd = useStore((state) => state.system?.execution.defaultCwd)
  const home = useStore((state) => state.system?.machine.home)
  return shortenPath(path, { cwd: cwd ?? defaultCwd, home })
}

function lineCount(value: string) {
  if (!value) return 0
  return value.split('\n').length - (value.endsWith('\n') ? 1 : 0)
}
const lines = (count: number) => `${count} line${count === 1 ? '' : 's'}`

/** The skill a read loads: the folder name of a `SKILL.md`, the convention Pi's skill list points agents at. */
export function skillOf(path: string) {
  const parts = path.split('/')
  return parts.at(-1) === 'SKILL.md' && parts.length > 1 ? parts.at(-2) : undefined
}

function Read({ call }: { call: ToolCallView }) {
  const path = text(call.args.path)
  const shown = usePath(path)
  const skill = skillOf(path)
  const duration = useToolDuration(call)
  const offset = typeof call.args.offset === 'number' ? call.args.offset : undefined
  const limit = typeof call.args.limit === 'number' ? call.args.limit : undefined
  const range =
    offset || limit ? `:${offset ?? 1}${limit ? `-${(offset ?? 1) + limit - 1}` : '+'}` : ''
  const failed = call.status === 'error'
  const count = call.status === 'done' ? lineCount(call.output) : 0
  const image = call.images[0]
  // The image itself says what Pi's bare "Read image file [type]." note does; keep only notes that add something.
  const diagnostics = image
    ? call.diagnostics.filter((d) => !/^Read image file \[[^\]]+\]\.$/.test(d.message))
    : call.diagnostics
  return (
    <Tool defaultOpen={failed || !!image}>
      <ToolHeader
        meta={
          <>
            {count > 0 && <span>{lines(count)}</span>}
            {duration && <span>{duration}</span>}
          </>
        }
        name={skill ? 'skill' : 'read'}
        state={call.status}
        title={
          skill ? (
            <>
              <span className="text-brand">{skill}</span>
              <span className="text-muted-foreground/60"> · {shown}</span>
            </>
          ) : (
            <>
              {shown}
              <span className="text-muted-foreground/60">{range}</span>
            </>
          )
        }
      />
      <ToolContent>
        {failed ? (
          <ToolOutput isError output={call.output} />
        ) : image ? (
          <ToolSection>
            <ToolImage alt={shown} image={image} />
          </ToolSection>
        ) : (
          call.output && (
            <CodeBlock
              className="max-h-96 overflow-auto rounded-none border-none"
              code={call.output}
              language={languageFromPath(path)}
              showLineNumbers
              startLine={offset ?? 1}
            />
          )
        )}
        <ToolDiagnostics diagnostics={diagnostics} />
      </ToolContent>
    </Tool>
  )
}

/** Keeps a growing body scrolled to its end while `following`, as a running bash call does. */
function useFollow<T extends HTMLElement>(following: boolean, content: unknown) {
  const ref = useRef<T>(null)
  useEffect(() => {
    const element = ref.current
    if (following && element) element.scrollTop = element.scrollHeight
  }, [content, following])
  return ref
}

/** A file call's title: its path, or a shimmering verb until the model has written the path. */
function FileTitle({ path, verb }: { path: string; verb: string }) {
  const shown = usePath(path)
  return path ? shown : <Shimmer>{`${verb}…`}</Shimmer>
}

function Write({ call }: { call: ToolCallView }) {
  const path = text(call.args.path)
  const content = text(call.args.content)
  const duration = useToolDuration(call)
  const failed = call.status === 'error'
  const streaming = call.status === 'streaming'
  // Open while it streams in, so the file appears as it is written, and it stays open rather than jump shut when
  // the write lands; a write first seen finished starts closed.
  const [watched] = useState(streaming)
  const [toggled, setToggled] = useState<boolean>()
  const open = toggled ?? (watched || streaming || failed)
  const scroller = useFollow<HTMLDivElement>(streaming, content)
  return (
    <Tool onOpenChange={setToggled} open={open}>
      <ToolHeader
        meta={
          <>
            {content && (
              <span>
                {lines(lineCount(content))}
                {!streaming && ` · ${formatBytes(new TextEncoder().encode(content).length)}`}
              </span>
            )}
            {duration && <span>{duration}</span>}
          </>
        }
        name="write"
        state={call.status}
        title={<FileTitle path={path} verb="writing" />}
      />
      <ToolContent>
        {content && (
          <CodeBlock
            caret={streaming}
            className="max-h-96 overflow-auto rounded-none border-none"
            code={content}
            language={languageFromPath(path)}
            ref={scroller}
            showLineNumbers
          />
        )}
        {failed && <ToolOutput isError output={call.output} />}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}

interface EditDetails {
  diff?: string
  patch?: string
}

function Edit({ call }: { call: ToolCallView }) {
  const path = text(call.args.path)
  const duration = useToolDuration(call)
  const streaming = call.status === 'streaming'
  const details = (call.details ?? {}) as EditDetails
  const edits = Array.isArray(call.args.edits)
    ? (call.args.edits as { oldText?: string; newText?: string }[])
    : [{ oldText: text(call.args.oldText), newText: text(call.args.newText) }]
  const rows = details.patch
    ? parsePatch(details.patch)
    : details.diff
      ? parseDisplayDiff(details.diff)
      : editRows(edits)
  // Counts only once the model has written the whole call: mid-stream they would still change.
  const { added, removed } = countChanges(streaming ? [] : rows)
  const failed = call.status === 'error'
  const scroller = useFollow<HTMLDivElement>(streaming, rows.length)
  return (
    <Tool defaultOpen>
      <ToolHeader
        meta={
          <>
            {added + removed > 0 && (
              <span>
                <span className="text-diff-add">+{added}</span>{' '}
                <span className="text-diff-del">−{removed}</span>
              </span>
            )}
            {duration && <span>{duration}</span>}
          </>
        }
        name="edit"
        state={call.status}
        title={<FileTitle path={path} verb="editing" />}
      />
      <ToolContent>
        {failed ? (
          <ToolOutput isError output={call.output} />
        ) : (
          <Diff caret={streaming} className="max-h-[28rem]" ref={scroller} rows={rows} />
        )}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}

function exitOf(call: ToolCallView): { label: string; ok: boolean } | undefined {
  if (call.status === 'done' && /\n\[Cancelled by the user after [^\]]*\]$/.test(call.output))
    return { label: 'cancelled', ok: false }
  if (call.status === 'done') return { label: 'exit 0', ok: true }
  if (call.status === 'interrupted') return { label: 'interrupted', ok: false }
  if (call.status !== 'error') return undefined
  const exited = call.diagnostics.find((diagnostic) => diagnostic.code === 'exit_code')
  const code = exited && /\d+/.exec(exited.message)?.[0]
  if (code) return { label: `exit ${code}`, ok: false }
  const messages = call.diagnostics.map((diagnostic) => diagnostic.message).join('\n')
  if (/timed out/.test(messages)) return { label: 'timeout', ok: false }
  if (/aborted/i.test(messages)) return { label: 'aborted', ok: false }
  return { label: 'failed', ok: false }
}

const separators: Record<string, string> = { '&&': '&&', '||': '||', ';': '·' }

/** The file a heredoc writes, by name: `cat > src/a.ts <<EOF` writes `a.ts`. */
const written = (step: BashStep) =>
  step.heredocs
    .find((heredoc) => heredoc.file && !heredoc.file.startsWith('heredoc.'))
    ?.file?.split('/')
    .at(-1)

/** The header line: each step's programs joined by pipe arrows, steps by their operators, repeats folded. */
function BashSummary({ steps }: { steps: BashStep[] }) {
  const runs: { step: BashStep; count: number }[] = []
  for (const step of steps) {
    const previous = runs.at(-1)
    if (
      previous &&
      previous.step.programs.join() === step.programs.join() &&
      step.operator !== '||'
    )
      previous.count++
    else runs.push({ step, count: 1 })
  }
  return (
    <>
      {runs.map(({ step, count }, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- Ordered command runs can repeat the same programs.
        <span key={index}>
          {index > 0 && (
            <span className="px-1.5 text-muted-foreground/50">
              {separators[step.operator ?? ';']}
            </span>
          )}
          {step.programs.map((name, position) => {
            const [program, ...rest] = name.split(' ')
            return (
              // oxlint-disable-next-line react/no-array-index-key -- Pipeline positions; programs can repeat.
              <span key={position}>
                {position > 0 && <span className="px-1 text-brand/70">→</span>}
                <span className="text-foreground/90">{program}</span>
                {rest.length > 0 && (
                  <span className="text-muted-foreground"> {rest.join(' ')}</span>
                )}
              </span>
            )
          })}
          {written(step) && <span className="text-muted-foreground"> &gt; {written(step)}</span>}
          {count > 1 && <span className="pl-1 text-muted-foreground/60">×{count}</span>}
        </span>
      ))}
    </>
  )
}

/** Cancel a running bash call: its command is killed and the model gets the output so far. */
function CancelCall({ callId }: { callId: string }) {
  const conversationId = useConversation((conversation) => conversation.id)
  const [sent, setSent] = useState(false)
  const cancel = () => {
    setSent(true)
    api.action(CancelAction, { callId }, { conversationId }).catch((error: unknown) => {
      setSent(false)
      throw error
    })
  }
  return (
    <button
      aria-label="Cancel this command"
      className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
      disabled={sent}
      onClick={cancel}
      title="Cancel this command; the agent gets the output so far"
      type="button"
    >
      <XIcon className="size-3" />
    </button>
  )
}

function Bash({ call }: { call: ToolCallView }) {
  const command = text(call.args.command)
  const display = useMemo(() => formatBashCommand(command), [command])
  const directory = usePath(display.directory ?? '')
  const parsed = display.steps.some((step) => step.programs.length > 0)
  const plain =
    parsed &&
    display.steps.length === 1 &&
    display.steps[0].programs.length === 1 &&
    !display.directory &&
    !command.includes('\n')
  const duration = useToolDuration(call)
  const exit = exitOf(call)
  const output = call.output
  const running = call.status === 'running'
  const [toggled, setToggled] = useState<boolean>()
  const open = toggled ?? (running || call.status === 'error')
  const scroller = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const element = scroller.current
    if (running && element) element.scrollTop = element.scrollHeight
  }, [output, running])
  return (
    <Tool onOpenChange={setToggled} open={open}>
      <ToolHeader
        meta={
          <>
            {display.directory && (
              <span className="max-w-48 truncate" title={display.directory}>
                {directory}
              </span>
            )}
            {exit && !exit.ok && (
              <span className={exit.label === 'cancelled' ? 'text-warning' : 'text-error'}>
                {exit.label}
              </span>
            )}
            {duration && <span>{duration}</span>}
          </>
        }
        action={running && <CancelCall callId={call.id} />}
        name="$"
        state={call.status}
        title={
          <span title={command.split('\n')[0]}>
            {plain || !parsed ? (
              <span className="text-foreground/90">{command.split('\n')[0]}</span>
            ) : (
              <BashSummary steps={display.steps} />
            )}
          </span>
        }
      />
      <ToolContent>
        {!plain && (
          <ToolSection className="space-y-1.5">
            {display.directory && (
              <div className="flex gap-2 text-muted-foreground/70">
                <span className="w-4 shrink-0 text-muted-foreground/50">$</span>
                <span className="min-w-0 truncate" title={display.directory}>
                  cd {directory}
                </span>
              </div>
            )}
            {display.steps.map((step, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- Command steps are positional and may repeat.
              <div className="flex gap-2" key={index}>
                <span className="w-4 shrink-0 pt-px text-muted-foreground/50">
                  {step.operator ?? (display.directory ? '&&' : '$')}
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <CodeBlock
                    className="rounded-none border-none bg-transparent [&_pre]:p-0 [&_pre]:whitespace-pre-wrap [&_.whitespace-pre]:whitespace-pre-wrap"
                    code={step.text}
                    language="bash"
                  />
                  {step.heredocs.map((heredoc, position) => (
                    // oxlint-disable-next-line react/no-array-index-key -- Heredoc positions; delimiters and files may repeat.
                    <div className="border-l-2 border-border/80" key={position}>
                      <CodeBlock
                        className="rounded-none border-none"
                        code={heredoc.body}
                        language={languageFromPath(heredoc.file ?? '')}
                      />
                      <pre className="px-3 text-muted-foreground/60">{heredoc.closing}</pre>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </ToolSection>
        )}
        {(output || running) && (
          <pre
            className="max-h-80 overflow-auto bg-terminal px-3 py-2 leading-[1.55] whitespace-pre-wrap text-foreground/85"
            ref={scroller}
          >
            {call.dropped && (
              <div className="text-muted-foreground/70">
                … {call.dropped.lines.toLocaleString()} earlier lines dropped
              </div>
            )}
            <AnsiOutput output={output} />
            {running && (
              <span className="ml-px inline-block h-3.5 w-1.5 animate-pulse-dot bg-brand align-middle" />
            )}
          </pre>
        )}
        {!output && !running && (
          <ToolSection className={cn('text-muted-foreground/70')}>no output</ToolSection>
        )}
        <ToolDiagnostics diagnostics={call.diagnostics.filter((d) => d.code !== 'tool_error')} />
      </ToolContent>
    </Tool>
  )
}

/** A file tool as a step line: its verb and path. */
const fileLine = (verb: string) =>
  function FileLine({ call }: { call: ToolCallView }) {
    return (
      <>
        <span className="text-foreground/80">{verb}</span> {usePath(text(call.args.path))}
      </>
    )
  }

/** A read as a step line; a skill's `SKILL.md` names the skill it loads. */
function ReadLine({ call }: { call: ToolCallView }) {
  const path = text(call.args.path)
  const shown = usePath(path)
  const skill = skillOf(path)
  return skill ? (
    <>
      <span className="text-foreground/80">skill</span> <span className="text-brand">{skill}</span>
    </>
  ) : (
    <>
      <span className="text-foreground/80">read</span> {shown}
    </>
  )
}

/** A bash call as a step line: its programs, as its header shows them. */
function BashLine({ call }: { call: ToolCallView }) {
  const command = text(call.args.command)
  const display = useMemo(() => formatBashCommand(command), [command])
  return (
    <>
      <span className="text-foreground/80">$</span>{' '}
      {display.steps.some((step) => step.programs.length > 0) ? (
        <BashSummary steps={display.steps} />
      ) : (
        command.split('\n')[0]
      )}
    </>
  )
}

export default defineWebExtension({
  tools: { read: Read, write: Write, edit: Edit, bash: Bash },
  toolLines: {
    read: ReadLine,
    write: fileLine('write'),
    edit: fileLine('edit'),
    bash: BashLine,
  },
})
