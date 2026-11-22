/** @jsxImportSource @solidjs/web */
import { Bell, BookOpen, Brain } from '@lucide/solid'
import { createMemo, For, Show } from 'solid-js'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolOutput,
  ToolSection,
  ToolStatusIcon,
} from '@/components/ai/tool.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  useToolDuration,
  cn,
  switchConversation,
  type SolidToolProps,
  type ToolCallView,
} from '@/sdk/solid'
import { parseConversationId } from '../../lib/ids.ts'
import { ConversationRef } from '../conversations/ui.solid.tsx'
import { MemoryChip } from './ui.solid.tsx'

const words = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const failed = (call: ToolCallView) => call.status === 'error' || call.status === 'interrupted'

type RememberOp = {
  op: 'add' | 'update' | 'delete'
  slug: string
  kind?: string
  line?: string
  body?: string
  source?: string
}

function rememberOps(ops: unknown): RememberOp[] {
  if (!Array.isArray(ops)) return []
  return ops.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const { op, slug, kind, line, body, source } = raw as Record<string, unknown>
    if ((op !== 'add' && op !== 'update' && op !== 'delete') || !words(slug)) return []
    const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)
    return [
      {
        op,
        slug: words(slug),
        kind: text(kind),
        line: text(line),
        body: text(body),
        source: text(source),
      },
    ]
  })
}

const verbs = { add: 'added', update: 'updated', delete: 'deleted' } as const

function rememberSummary(ops: readonly RememberOp[]) {
  if (ops.length === 1) return `${verbs[ops[0].op]} ${ops[0].slug}`
  return (['add', 'update', 'delete'] as const)
    .map((op) => [op, ops.filter((item) => item.op === op).length] as const)
    .filter(([, count]) => count)
    .map(([op, count]) => `${verbs[op]} ${count}`)
    .join(' · ')
}

const prose = 'font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/90'

export function RememberCall(props: SolidToolProps) {
  const duration = useToolDuration(() => props.call)
  const ops = createMemo(() => rememberOps(props.call.args.ops))
  const slugs = createMemo(() => [
    ...new Set(
      ops()
        .filter((op) => op.op !== 'delete')
        .map((op) => op.slug),
    ),
  ])
  const onlyChip = () => ops().length === 1 && slugs().length === 1
  return (
    <Show when={!failed(props.call)} fallback={props.core}>
      <Tool>
        <ToolHeader
          action={
            slugs().length > 0 ? (
              <span
                class={cn(
                  'max-w-[45%] shrink-0 items-center gap-1 overflow-hidden',
                  onlyChip() ? 'flex' : 'hidden sm:flex',
                )}
              >
                <For each={slugs().slice(0, 2)}>
                  {(slug) => (
                    <MemoryChip
                      class="min-w-0"
                      name={`Open memory ${slug} (remember call ${props.call.id})`}
                      slug={slug}
                    />
                  )}
                </For>
                <Show when={slugs().length > 2}>
                  <span class="shrink-0 font-mono text-[10px] text-muted-foreground">
                    +{slugs().length - 2}
                  </span>
                </Show>
              </span>
            ) : undefined
          }
          aria-label={`Toggle remember call ${props.call.id}`}
          icon={Brain}
          meta={duration()}
          name=""
          state={props.call.status}
          title={
            <>
              <span class="text-foreground">Memory</span>
              <Show when={ops().length > 0}>
                <span> · {onlyChip() ? verbs[ops()[0].op] : rememberSummary(ops())}</span>
              </Show>
            </>
          }
        />
        <ToolContent>
          <For each={ops()} keyed={false}>
            {(op, index) => (
              <ToolSection class="border-b border-border/50 last:border-b-0">
                <div class="flex min-w-0 items-center gap-2">
                  <span
                    class={cn(
                      'shrink-0 section-label',
                      op().op === 'delete' ? 'text-error/80' : 'text-muted-foreground/80',
                    )}
                  >
                    {verbs[op().op]}
                  </span>
                  <Show
                    when={op().op !== 'delete'}
                    fallback={
                      <span class="truncate text-muted-foreground line-through">{op().slug}</span>
                    }
                  >
                    <MemoryChip
                      name={`Open memory ${op().slug} (operation ${index + 1} in call ${props.call.id})`}
                      slug={op().slug}
                    />
                  </Show>
                  <Show when={op().kind}>
                    <span class="shrink-0 text-muted-foreground">{op().kind}</span>
                  </Show>
                  <Show when={op().source}>
                    <span class="ml-auto shrink-0 text-[11px] text-muted-foreground/70">
                      {op().source}
                    </span>
                  </Show>
                </div>
                <Show when={op().line}>
                  <p class={cn(prose, 'font-medium text-foreground')}>{op().line}</p>
                </Show>
                <Show when={op().body}>
                  <p class={cn(prose, 'text-foreground/80')}>{op().body}</p>
                </Show>
              </ToolSection>
            )}
          </For>
        </ToolContent>
      </Tool>
    </Show>
  )
}

export function MemoryCall(props: SolidToolProps) {
  const duration = useToolDuration(() => props.call)
  const slugs = createMemo(() => {
    const read = props.call.args.read
    return (Array.isArray(read) ? read : [read]).map(words).filter(Boolean)
  })
  const query = () => words(props.call.args.query)
  return (
    <Show when={!failed(props.call)} fallback={props.core}>
      <Tool>
        <ToolHeader
          action={
            slugs().length > 0 ? (
              <span class="flex min-w-0 gap-1">
                <For each={slugs()} keyed={false}>
                  {(slug, index) => (
                    <MemoryChip
                      class="shrink-0"
                      name={`Open memory ${slug()} (item ${index + 1} in call ${props.call.id})`}
                      slug={slug()}
                    />
                  )}
                </For>
              </span>
            ) : undefined
          }
          aria-label={`Toggle memory call ${props.call.id}`}
          icon={BookOpen}
          meta={duration()}
          name=""
          state={props.call.status}
          title={
            query()
              ? `Search memory: ${query()}`
              : slugs().length > 1
                ? 'Read memories'
                : slugs().length
                  ? 'Read memory'
                  : 'Read the memory index'
          }
        />
        <ToolContent>
          <ToolOutput output={props.call.output} />
        </ToolContent>
      </Tool>
    </Show>
  )
}

export function NotifyCall(props: SolidToolProps) {
  const id = () =>
    typeof props.call.args.id === 'number' ? parseConversationId(props.call.args.id) : undefined
  return (
    <Show when={!failed(props.call)} fallback={props.core}>
      <Tool>
        <div class="flex h-8 min-w-0 items-center gap-2 px-2.5 text-muted-foreground">
          <ToolStatusIcon icon={Bell} state={props.call.status} />
          <span class="shrink-0 text-foreground">Notify when</span>
          <Show when={id()}>
            {(conversation) => (
              <Button
                aria-label={`Open #${conversation()} (notify call ${props.call.id})`}
                class="min-w-0 shrink overflow-hidden font-mono text-[12px] font-normal text-foreground/85 hover:underline"
                onClick={() => switchConversation(conversation())}
                size={null}
                title={`Open #${conversation()}`}
                type="button"
                variant={null}
              >
                <ConversationRef id={conversation()} />
              </Button>
            )}
          </Show>
          <span class="shrink-0">finishes</span>
          <Show when={props.call.args.wake === false}>
            <span class="ml-auto shrink-0 text-[11px]" title="Leaves a note instead of waking">
              <span class="hidden sm:inline">as a note, </span>no wake-up
            </span>
          </Show>
        </div>
      </Tool>
    </Show>
  )
}
