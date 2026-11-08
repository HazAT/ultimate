import {
  ArrowUpRightIcon,
  CheckIcon,
  ChevronRightIcon,
  ClipboardListIcon,
  MessageCircleQuestionIcon,
  PlayIcon,
  PlusIcon,
} from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { api, cn, errorMessage, events, formatAgo, useDocOf, useNow, useUltimate } from '@/sdk'
import {
  Address,
  MessagesDoc,
  emptyMessages,
  useAccentOf,
  UserActionsProvider,
  useUserActions,
  useOpenUserAction,
} from '../messages/ui.tsx'
import type { UserAction } from '../messages/ui.tsx'
import type { Question } from '../messages/refs.ts'
import { waiting } from '../questions/ui.tsx'
import { StandingAction } from '../subagents/ui.tsx'
import { AddAction, DoneAction, ReopenAction, TodosDoc } from './refs.ts'
import type { Todo } from './refs.ts'

/** The fields of a waiting message a question row shows. */
type Asked = {
  id: number
  from: number | 'user' | 'remote'
  text: string
  at: number
  call?: string
  remote?: { project: string; machine: string }
  questions?: Question[]
}

const owners: { id: Todo['owner']; label: string }[] = [
  { id: 'user', label: 'you' },
  { id: 'ultimate', label: '@ultimate' },
]

/**
 * The project's to-dos: what waits on you (questions asked of you, read live from Messages, then your own to-dos), what
 * @ultimate is still on, a field to add one for either of you, and the done ones folded away. A question is answered
 * where it was asked: its row opens that conversation at the message, whose card has the choices and Dismiss.
 */
export function Todos() {
  return (
    <UserActionsProvider>
      <TodoList />
    </UserActionsProvider>
  )
}

function TodoList() {
  const approvals = useUserActions()
  const items = useDocOf(1, TodosDoc)?.items ?? []
  const questions = waiting((useDocOf(1, MessagesDoc) ?? emptyMessages).messages)
  const now = useNow(60_000)
  const [error, setError] = useState<string>()
  const open = items.filter((todo) => !todo.done)
  const yours = open.filter((todo) => todo.owner === 'user')
  const ultimate = open.filter((todo) => todo.owner === 'ultimate')
  const done = items.filter((todo) => todo.done).toReversed()
  const count = questions.length + approvals.length + open.length

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
              {questions.length} {questions.length === 1 ? 'question' : 'questions'}
              {(open.length > 0 || approvals.length > 0) && ' · '}
            </span>
          )}
          {approvals.length > 0 && (
            <span className="text-amber-700 dark:text-amber-300">
              {approvals.length} {approvals.length === 1 ? 'action' : 'actions'}
              {open.length > 0 && ' · '}
            </span>
          )}
          {open.length
            ? `${open.length} open`
            : questions.length || approvals.length
              ? ''
              : 'none open'}
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
          <Section
            title="For you"
            owner="user"
            empty={!questions.length && !approvals.length && !yours.length}
          >
            {approvals.map((action) => (
              <PendingActionRow key={`${action.conversation}:${action.id}`} action={action} />
            ))}
            {questions.map((message) => (
              <QuestionRow key={`q${message.id}`} message={message} now={now} />
            ))}
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

function PendingActionRow({ action }: { action: UserAction }) {
  const open = useOpenUserAction()
  return (
    <li data-todo-action={action.id}>
      <button
        type="button"
        onClick={() => open(action)}
        className="group/action flex w-full cursor-pointer items-start gap-2.5 rounded px-2 py-1.5 text-left hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ClipboardListIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-[13px] leading-snug">{action.label}</span>
          <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <Address id={action.conversation} /> review <ArrowUpRightIcon className="size-3" />
          </span>
        </span>
      </button>
    </li>
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
          {age}
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

/**
 * One question waiting on you: its gist, who asks and how long ago. A click opens the asker's conversation at the
 * message, where its answer card offers the choices, a reply and Dismiss.
 */
function QuestionRow({ message, now }: { message: Asked; now: number }) {
  const questions = message.questions ?? []
  const { showSurface, switchConversation } = useUltimate()
  const accent = useAccentOf(message.from)
  const more = questions.length > 1 ? ` +${questions.length - 1}` : ''
  const from = typeof message.from === 'number' ? message.from : undefined
  const open = () => {
    if (from === undefined) return
    if (message.call) events.emit('messages:open', { conversation: from, call: message.call })
    showSurface('agent')
    switchConversation(from)
  }
  return (
    <li data-todo-question={message.id}>
      <button
        className="group/question flex w-full cursor-pointer items-start gap-2.5 rounded px-2 py-1.5 text-left hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default"
        disabled={from === undefined}
        onClick={open}
        title={from === undefined ? undefined : `Answer in #${from}`}
        type="button"
      >
        <MessageCircleQuestionIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-[13px] leading-snug">
            {questions[0]?.text ?? gist(message.text)}
            {more && (
              <span className="ml-1 font-mono text-[11px] text-muted-foreground">{more}</span>
            )}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 font-mono text-[11px]">
            <span className={cn('flex min-w-0 font-semibold', accent.name)}>
              <Address id={message.from} remote={message.remote} />
            </span>
            {from !== undefined && (
              <span className="flex shrink-0 items-center gap-0.5 text-muted-foreground/70 transition-colors group-hover/question:text-foreground">
                answer
                <ArrowUpRightIcon className="size-3" />
              </span>
            )}
          </span>
        </span>
        <time
          className="shrink-0 pt-px font-mono text-[11px] text-muted-foreground/70"
          dateTime={new Date(message.at).toISOString()}
          title={`Asked ${new Date(message.at).toLocaleString()}`}
        >
          {formatAgo(message.at, now)}
        </time>
      </button>
    </li>
  )
}

/** A message's first line of prose, without Markdown marks. */
const gist = (text: string) =>
  (text.split('\n').find((line) => line.trim()) ?? '')
    .replace(/^[#>\-*\s]+/, '')
    .replace(/[*_`]/g, '')
    .trim()

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
