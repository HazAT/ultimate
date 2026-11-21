/** @jsxImportSource @solidjs/web */
import type { JSX } from '@solidjs/web'
import { Check, ChevronRight, Inbox, Play, Plus } from '@lucide/solid'
import { For, Show, createMemo, createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Checkbox } from '@/components/ui/checkbox.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import { Form } from '@/components/ui/form.solid.tsx'
import { Input } from '@/components/ui/input.solid.tsx'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control.solid.tsx'
import {
  ROOT,
  api,
  cn,
  errorMessage,
  events,
  formatAgo,
  showSurface,
  switchConversation,
  useDocOf,
  useExtensionUiState,
  useNow,
  writingAs,
} from '@/sdk/solid'
import { Waiting } from '../inbox/ui.solid.tsx'
import { StandingAction } from '../subagents/refs.ts'
import { AddAction, DoneAction, ReopenAction, TodosDoc } from './refs.ts'
import type { Todo } from './refs.ts'

const waits = 'text-amber-700 dark:text-amber-300'

export function TodoList() {
  const { entries, failures } = Waiting()
  const inbox = () => entries().length
  const doc = useDocOf(() => ROOT, TodosDoc)
  const now = useNow(60_000)
  const [error, setError] = createSignal<string>()
  const items = () => doc()?.items ?? []
  const open = createMemo(() => items().filter((todo) => !todo.done))
  const yours = () => open().filter((todo) => todo.owner === 'user')
  const ultimate = () => open().filter((todo) => todo.owner === 'ultimate')
  const done = createMemo(() =>
    items()
      .filter((todo) => todo.done)
      .toReversed(),
  )
  const [doneOpen, setDoneOpen] = useExtensionUiState('done', false)

  const run = (action: Promise<unknown>) => {
    setError(undefined)
    return action.then(
      () => true,
      (cause: unknown) => {
        setError(errorMessage(cause))
        return false
      },
    )
  }
  const toggle = (todo: Todo) =>
    run(api.action(todo.done ? ReopenAction : DoneAction, { id: todo.id }))
  const start = (todo: Todo, source: string) =>
    run(
      (async () => {
        const id = await api.action(StandingAction, { name: 'ultimate' })
        events.emit('ultimate:sent', { conversationId: id })
        await writingAs(source, () =>
          api.submit(
            `${todo.owner === 'user' ? 'Help me with' : 'Work on'} to-do #${todo.id}: ${todo.text}`,
            'followUp',
            id,
          ),
        )
        writingAs(source, () => {
          showSurface('agent')
          switchConversation(id)
        })
      })(),
    )

  return (
    <div class="py-2" data-todos>
      <div class="flex items-center gap-2 px-3 pb-2 section-label">
        To-dos
        <span class="ml-auto text-muted-foreground/70">
          <Show when={inbox() > 0}>
            <span class={waits}>
              {inbox()} in Inbox
              {open().length > 0 && ' · '}
            </span>
          </Show>
          {open().length ? `${open().length} open` : inbox() ? '' : 'none open'}
        </span>
      </div>
      <AddTodo add={(text, owner) => run(api.action(AddAction, { text, owner }))} />
      <Show when={error()}>
        <p class="px-3 pt-1.5 font-mono text-[11px] break-words text-error">{error()}</p>
      </Show>
      {failures}
      <Show
        when={inbox() + open().length > 0}
        fallback={
          <p class="flex items-center gap-2 px-3 py-6 text-xs text-muted-foreground">
            <Check class="size-3.5 text-success" />
            Nothing open for you or @ultimate.
          </p>
        }
      >
        <Section empty={!inbox() && !yours().length} owner="user" title="For you">
          <Show when={inbox() > 0}>
            <li data-todo-inbox>
              <Button
                class="flex h-auto w-full items-center justify-start gap-2.5 rounded px-2 py-1.5 text-left font-normal hover:bg-muted/50"
                onClick={() => showSurface('inbox')}
                size={null}
                variant={null}
              >
                <Inbox class={cn('size-4 shrink-0', waits)} />
                <span class={cn('min-w-0 flex-1 text-[13px]', waits)}>Inbox · {inbox()}</span>
                <ChevronRight class="size-3.5 shrink-0 text-muted-foreground/60" />
              </Button>
            </li>
          </Show>
          <For each={yours()} keyed={(todo) => todo.id}>
            {(todo) => <TodoRow now={now()} start={start} todo={todo()} toggle={toggle} />}
          </For>
        </Section>
        <Section empty={!ultimate().length} owner="ultimate" title="For @ultimate">
          <For each={ultimate()} keyed={(todo) => todo.id}>
            {(todo) => <TodoRow now={now()} start={start} todo={todo()} toggle={toggle} />}
          </For>
        </Section>
      </Show>
      <Show when={done().length > 0}>
        <Collapsible bind={[doneOpen, setDoneOpen]} class="mt-2" data-todos-done>
          <CollapsibleTrigger class="group/done flex items-center gap-1 px-3 py-1.5 section-label outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring">
            <ChevronRight class="size-3 transition-transform group-data-open/done:rotate-90" />
            Done · {done().length}
          </CollapsibleTrigger>
          <CollapsibleContent render={(panel) => <ul {...panel} class="px-1" />}>
            <For each={done()} keyed={(todo) => todo.id}>
              {(todo) => <TodoRow now={now()} todo={todo()} toggle={toggle} />}
            </For>
          </CollapsibleContent>
        </Collapsible>
      </Show>
    </div>
  )
}

function Section(props: {
  title: string
  owner: Todo['owner']
  empty: boolean
  children: JSX.Element
}) {
  return (
    <section class="mt-3" data-todos-section={props.owner}>
      <h3 class="px-3 pb-1 font-mono text-[11px] text-muted-foreground">{props.title}</h3>
      <Show
        when={!props.empty}
        fallback={<p class="px-3 py-1 text-xs text-muted-foreground/70">Nothing open.</p>}
      >
        <ul class="px-1">{props.children}</ul>
      </Show>
    </section>
  )
}

function TodoRow(props: {
  todo: Todo
  now: number
  toggle: (todo: Todo) => Promise<boolean>
  start?: (todo: Todo, source: string) => Promise<boolean>
}) {
  const at = () => props.todo.done ?? props.todo.at
  const help = () =>
    props.todo.owner === 'user' ? 'Ask @ultimate to help with this' : 'Have @ultimate work on this'
  return (
    <li class="group/todo flex items-start rounded hover:bg-muted/50" data-todo={props.todo.id}>
      <label class="flex min-w-0 flex-1 items-start gap-2.5 py-1.5 pl-2">
        <Checkbox
          aria-label={`${props.todo.done ? 'Reopen' : 'Done'} #${props.todo.id}: ${props.todo.text}`}
          bind={[() => !!props.todo.done, () => void props.toggle(props.todo)]}
          class={cn(
            'mt-0.5',
            props.todo.done &&
              'data-checked:border-muted-foreground/40 data-checked:bg-muted data-checked:text-muted-foreground',
          )}
        />
        <span
          class={cn(
            'min-w-0 flex-1 text-[13px] leading-snug break-words',
            props.todo.done && 'text-muted-foreground line-through decoration-muted-foreground/50',
          )}
        >
          {props.todo.text}
        </span>
        <time
          class="shrink-0 pt-px font-mono text-[11px] text-muted-foreground/70"
          datetime={new Date(at()).toISOString()}
          title={`${props.todo.done ? 'Done' : 'Added'} ${new Date(at()).toLocaleString()}`}
        >
          {props.todo.done && props.todo.owner === 'ultimate' ? '@ultimate · ' : ''}
          {props.todo.id} · {formatAgo(at(), props.now)}
        </time>
      </label>
      <Show when={props.start && !props.todo.done} fallback={<span class="w-2 shrink-0" />}>
        <Button
          aria-label={`${help()} #${props.todo.id}: ${props.todo.text}`}
          class="mt-1 mr-2 ml-1 size-5 rounded text-muted-foreground opacity-0 group-hover/todo:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100"
          data-todo-start
          onClick={(_, details) => props.start?.(props.todo, details.source)}
          size="icon-xs"
          title={help()}
          variant="ghost"
        >
          <Play class="size-3" />
        </Button>
      </Show>
    </li>
  )
}

function AddTodo(props: { add: (text: string, owner: Todo['owner']) => Promise<boolean> }) {
  const [text, setText] = createSignal('')
  const [sending, setSending] = createSignal(false)
  const [stored, setOwner] = useExtensionUiState<Todo['owner']>('owner', 'user')
  const owner = (): Todo['owner'] => (stored() === 'ultimate' ? 'ultimate' : 'user')
  const submit = async () => {
    const trimmed = text().trim()
    if (!trimmed || sending()) return
    setSending(true)
    if (await props.add(trimmed, owner())) setText('')
    setSending(false)
  }
  return (
    <Form class="mx-2 flex items-center gap-1 rounded-md border border-border bg-background pl-1 focus-within:border-brand/60">
      <Button
        aria-label="Add the to-do"
        class="-ml-1 size-6 text-muted-foreground hover:text-foreground"
        disabled={sending()}
        onClick={submit}
        size="icon-xs"
        type="submit"
        variant="ghost"
      >
        <Plus class="size-3.5" />
      </Button>
      <Input
        aria-label="To-do text"
        class="h-8 flex-1 border-0 bg-transparent px-1 font-sans text-[13px] focus-visible:ring-0"
        disabled={sending()}
        maxlength={300}
        onValueChange={setText}
        placeholder="Add a to-do…"
        value={text()}
      />
      <SegmentedControl
        aria-label="To-do owner"
        bind={[owner, setOwner]}
        class="mr-1 rounded border-border/70 p-px"
      >
        <SegmentedControlItem class="h-5 rounded-[3px]" value="user">
          you
        </SegmentedControlItem>
        <SegmentedControlItem class="h-5 rounded-[3px]" value="ultimate">
          @ultimate
        </SegmentedControlItem>
      </SegmentedControl>
    </Form>
  )
}
