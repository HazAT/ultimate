import { CheckIcon, ChevronRightIcon, InboxIcon, PlayIcon, PlusIcon } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { api, cn, errorMessage, events, formatAgo, useDocOf, useNow, useUltimate } from '@/sdk'
import { Waiting } from '../inbox/ui.tsx'
import { stateTone } from '../messages/ui.tsx'
import { StandingAction } from '../subagents/ui.tsx'
import { AddAction, DoneAction, ReopenAction, TodosDoc } from './refs.ts'
import type { Todo } from './refs.ts'

const owners: { id: Todo['owner']; label: string }[] = [
  { id: 'user', label: 'you' },
  { id: 'ultimate', label: '@ultimate' },
]

/**
 * The project's to-dos: what waits on you (one Inbox row for the questions asked of you and the other extensions'
 * Inbox items, then your own to-dos), what @ultimate is still on, a field to add one for either of you, and the done
 * ones folded away. Inbox entries are answered in the Inbox.
 */
export function Todos() {
  return <Waiting>{(entries) => <List questions={entries} />}</Waiting>
}

function List({ questions }: { questions: readonly unknown[] }) {
  const items = useDocOf(1, TodosDoc)?.items ?? []
  const now = useNow(60_000)
  const [error, setError] = useState<string>()
  const open = items.filter((todo) => !todo.done)
  const yours = open.filter((todo) => todo.owner === 'user')
  const ultimate = open.filter((todo) => todo.owner === 'ultimate')
  const done = items.filter((todo) => todo.done).toReversed()
  const count = questions.length + open.length

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
    void run(api.action(todo.done ? ReopenAction : DoneAction, { id: todo.id }))
  const { showSurface, switchConversation } = useUltimate()
  // Sent as the user, like typing it into @ultimate's composer; a busy @ultimate takes it after its current run.
  const start = (todo: Todo) =>
    void run(
      (async () => {
        const id = await api.action(StandingAction, { name: 'ultimate' })
        events.emit('ultimate:sent', { conversationId: id })
        await api.submit(
          `${todo.owner === 'user' ? 'Help me with' : 'Work on'} to-do #${todo.id}: ${todo.text}`,
          'followUp',
          id,
        )
        showSurface('agent')
        switchConversation(id)
      })(),
    )

  return (
    <div className="py-2" data-todos>
      <div className="flex items-center gap-2 px-3 pb-2 section-label">
        To-dos
        <span className="ml-auto text-muted-foreground/70">
          {questions.length > 0 && (
            <span className="text-amber-700 dark:text-amber-300">
              {questions.length} in Inbox
              {open.length > 0 && ' · '}
            </span>
          )}
          {open.length ? `${open.length} open` : questions.length ? '' : 'none open'}
        </span>
      </div>
      <AddTodo add={(text, owner) => run(api.action(AddAction, { text, owner }))} />
      {error && <p className="px-3 pt-1.5 font-mono text-[11px] break-words text-error">{error}</p>}
      {count === 0 ? (
        <p className="flex items-center gap-2 px-3 py-6 text-xs text-muted-foreground">
          <CheckIcon className="size-3.5 text-success" />
          Nothing open for you or @ultimate.
        </p>
      ) : (
        <>
          <Section title="For you" owner="user" empty={!questions.length && !yours.length}>
            {questions.length > 0 && <InboxRow count={questions.length} />}
            {yours.map((todo) => (
              <TodoRow key={todo.id} todo={todo} now={now} toggle={toggle} start={start} />
            ))}
          </Section>
          <Section title="For @ultimate" owner="ultimate" empty={!ultimate.length}>
            {ultimate.map((todo) => (
              <TodoRow key={todo.id} todo={todo} now={now} toggle={toggle} start={start} />
            ))}
          </Section>
        </>
      )}
      {done.length > 0 && (
        <details className="group/done mt-2" data-todos-done>
          <summary className="flex cursor-pointer list-none items-center gap-1 px-3 py-1.5 section-label hover:text-foreground">
            <ChevronRightIcon className="size-3 transition-transform group-open/done:rotate-90" />
            Done · {done.length}
          </summary>
          <ul className="px-1">
            {done.map((todo) => (
              <TodoRow key={todo.id} todo={todo} now={now} toggle={toggle} />
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

/** A labelled group of rows; an empty one says so in a quiet line rather than disappearing. */
function Section({
  title,
  owner,
  empty,
  children,
}: {
  title: string
  owner: Todo['owner']
  empty: boolean
  children: ReactNode
}) {
  return (
    <section className="mt-3" data-todos-section={owner}>
      <h3 className="px-3 pb-1 font-mono text-[11px] text-muted-foreground">{title}</h3>
      {empty ? (
        <p className="px-3 py-1 text-xs text-muted-foreground/70">Nothing open.</p>
      ) : (
        <ul className="px-1">{children}</ul>
      )}
    </section>
  )
}

/**
 * One to-do: a check, its text and its age; ticking a done one reopens it. An open one also offers, on hover or focus,
 * to send @ultimate to work on it.
 */
function TodoRow({
  todo,
  now,
  toggle,
  start,
}: {
  todo: Todo
  now: number
  toggle: (todo: Todo) => void
  start?: (todo: Todo) => void
}) {
  const at = todo.done ?? todo.at
  const age = formatAgo(at, now)
  const label =
    todo.owner === 'user' ? 'Ask @ultimate to help with this' : 'Have @ultimate work on this'
  return (
    <li className="group/todo flex items-start rounded hover:bg-muted/50" data-todo={todo.id}>
      <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 py-1.5 pl-2">
        <Checkbox
          aria-label={todo.done ? `Reopen: ${todo.text}` : `Done: ${todo.text}`}
          checked={!!todo.done}
          className={cn(
            'mt-0.5',
            todo.done &&
              'data-[state=checked]:border-muted-foreground/40 data-[state=checked]:bg-muted data-[state=checked]:text-muted-foreground',
          )}
          onCheckedChange={() => toggle(todo)}
        />
        <span
          className={cn(
            'min-w-0 flex-1 text-[13px] leading-snug break-words',
            todo.done && 'text-muted-foreground line-through decoration-muted-foreground/50',
          )}
        >
          {todo.text}
        </span>
        <time
          className="shrink-0 pt-px font-mono text-[11px] text-muted-foreground/70"
          dateTime={new Date(at).toISOString()}
          title={`${todo.done ? 'Done' : 'Added'} ${new Date(at).toLocaleString()}`}
        >
          {todo.done && todo.owner === 'ultimate' ? '@ultimate · ' : ''}
          {todo.id} · {age}
        </time>
      </label>
      {start && !todo.done ? (
        <button
          aria-label={`${label}: ${todo.text}`}
          className="mt-1 mr-2 ml-1 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 group-hover/todo:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          data-todo-start
          onClick={() => start(todo)}
          title={label}
          type="button"
        >
          <PlayIcon className="size-3" />
        </button>
      ) : (
        <span className="w-2 shrink-0" />
      )}
    </li>
  )
}

/** The questions waiting on you, as one row: a click opens the Inbox, where each is answered. */
function InboxRow({ count }: { count: number }) {
  const { showSurface } = useUltimate()
  return (
    <li data-todo-inbox>
      <button
        className="flex w-full cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 text-left hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        onClick={() => showSurface('inbox')}
        type="button"
      >
        <InboxIcon className={cn('size-4 shrink-0', stateTone.waits)} />
        <span className={cn('min-w-0 flex-1 text-[13px]', stateTone.waits)}>Inbox · {count}</span>
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
      </button>
    </li>
  )
}

/** The add field: text, whose it is, Enter adds; the owner stays as last chosen. */
function AddTodo({ add }: { add: (text: string, owner: Todo['owner']) => Promise<boolean> }) {
  const [text, setText] = useState('')
  const [owner, setOwner] = useState<Todo['owner']>('user')
  const [sending, setSending] = useState(false)
  const submit = async () => {
    if (!text.trim() || sending) return
    setSending(true)
    if (await add(text.trim(), owner)) setText('')
    setSending(false)
  }
  return (
    <form
      className="mx-2 flex items-center gap-1 rounded-md border border-border bg-background pl-2 focus-within:border-brand/60"
      onSubmit={(event) => {
        event.preventDefault()
        // oxlint-disable-next-line typescript/no-floating-promises -- add delegates to run, which displays failures and resolves false.
        void submit()
      }}
    >
      <PlusIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        aria-label="New to-do"
        className="min-h-8 min-w-0 flex-1 bg-transparent px-1 py-1 text-[13px] outline-none placeholder:text-muted-foreground/70"
        disabled={sending}
        maxLength={300}
        onChange={(event) => setText(event.target.value)}
        placeholder="Add a to-do…"
        value={text}
      />
      <div
        aria-label="For"
        className="mr-1 flex shrink-0 rounded border border-border/70 p-px font-mono text-[11px]"
        role="radiogroup"
      >
        {owners.map((option) => (
          <button
            aria-checked={owner === option.id}
            className={cn(
              'cursor-pointer rounded-[3px] px-1.5 py-0.5 text-muted-foreground hover:text-foreground',
              owner === option.id && 'bg-muted text-foreground',
            )}
            key={option.id}
            onClick={() => setOwner(option.id)}
            role="radio"
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
    </form>
  )
}
