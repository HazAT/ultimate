import {
  CheckIcon,
  CircleIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  LoaderCircleIcon,
  NetworkIcon,
  XIcon,
} from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { api, cn, errorMessage, useAction, useCopy, useDialog, useRestart } from '@/sdk'
import { JoinAction, JoinStateAction } from './refs.ts'
import type { JoinResult, JoinState, JoinStep } from './refs.ts'

/** The dialog id the "Join cloud backups" command opens. */
export const joinDialog = 'cloud.join'

const steps: { id: JoinStep | 'done'; label: string }[] = [
  { id: 'check', label: 'Check cloud' },
  { id: 'secrets', label: 'Save secrets' },
  { id: 'settings', label: 'Save settings' },
  { id: 'done', label: 'Done' },
]

type StepState = 'pending' | 'running' | 'done' | 'failed'

/** Each step's state: all running-then-pending while the join runs, all done after it, done up to the failed one. */
function stepStates(result: JoinResult | 'running'): StepState[] {
  if (result === 'running') return steps.map((_, index) => (index === 0 ? 'running' : 'pending'))
  if (result.ok) return steps.map(() => 'done')
  const failed = steps.findIndex((step) => step.id === result.step)
  return steps.map((_, index) =>
    index < failed ? 'done' : index === failed ? 'failed' : 'pending',
  )
}

function StepIcon({ state }: { state: StepState }) {
  if (state === 'running')
    return <LoaderCircleIcon className="size-3 shrink-0 animate-spin text-brand" />
  if (state === 'done') return <CheckIcon className="size-3 shrink-0 text-success/70" />
  if (state === 'failed') return <XIcon className="size-3 shrink-0 text-error" />
  return <CircleIcon className="size-2 shrink-0 text-muted-foreground" />
}

/** The move card's step list, for the join's four steps. */
function Steps({ result }: { result: JoinResult | 'running' }) {
  const states = stepStates(result)
  return (
    <ol className="space-y-0.5" data-cloud-join-steps>
      {steps.map((step, index) => (
        <li
          className={cn(
            'flex min-w-0 items-center gap-2 leading-5',
            states[index] === 'running' ? 'text-brand' : 'text-muted-foreground',
            states[index] === 'pending' && 'text-muted-foreground',
          )}
          key={step.id}
        >
          <span className="flex w-3 shrink-0 justify-center">
            <StepIcon state={states[index]} />
          </span>
          {step.label}
        </li>
      ))}
    </ol>
  )
}

/** `pnpm setup:machine` as a code chip that copies itself. */
function Command({ value }: { value: string }) {
  const { copied, copy } = useCopy()
  return (
    <button
      aria-label={`Copy ${value}`}
      className="group flex w-full items-center gap-2 rounded-md border border-border/80 bg-background px-2 py-1.5 text-left text-foreground/90 transition-colors outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => copy(value)}
      title="Copy"
      type="button"
    >
      <span className="text-muted-foreground select-none">$</span>
      <code className="min-w-0 flex-1 break-all">{value}</code>
      {copied ? (
        <CheckIcon className="size-3.5 shrink-0 text-success" />
      ) : (
        <CopyIcon className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
      )}
    </button>
  )
}

const field =
  'h-7 w-full min-w-0 rounded-md border border-input bg-background px-2 font-mono text-[12px] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60'

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block space-y-1">
      <span className="flex items-baseline gap-2 text-muted-foreground">
        {label}
        {hint && <span className="text-muted-foreground">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

/** A secret field: a one-time code to the browser, hidden until the user shows it. */
function Secret({
  name,
  value,
  onChange,
  disabled,
}: {
  name: string
  value: string
  onChange: (value: string) => void
  disabled: boolean
}) {
  const [shown, setShown] = useState(false)
  return (
    <Field label={name}>
      <span className="flex items-center gap-1">
        <input
          aria-label={name}
          autoComplete="one-time-code"
          className={field}
          data-1p-ignore
          data-bwignore
          data-lpignore="true"
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Paste the value the other machines use"
          spellCheck={false}
          type={shown ? 'text' : 'password'}
          value={value}
        />
        <Button
          aria-label={shown ? `Hide ${name}` : `Show ${name}`}
          aria-pressed={shown}
          className="size-7 shrink-0 text-muted-foreground"
          onClick={() => setShown(!shown)}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          {shown ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
        </Button>
      </span>
    </Field>
  )
}

/** After a join: run setup:machine, restart, and the projects the cloud lists. */
function Next({ result }: { result: Extract<JoinResult, { ok: true }> }) {
  const restart = useRestart()
  return (
    <div className="space-y-2 border-t border-border/60 px-3 py-2" data-cloud-join-next>
      <div className="text-foreground/85">Next</div>
      <div className="space-y-1">
        <p className="font-sans text-[12px] text-muted-foreground">
          In the Ultimate clone, so Ultimate starts at login:
        </p>
        <Command value="pnpm setup:machine" />
      </div>
      <div className="flex items-start gap-3">
        <p className="flex-1 font-sans text-[12px] text-muted-foreground">
          Backups read <code>cloud.url</code> and the secrets from the next start on. Restart this
          Ultimate now, and any other running project from its own page.
        </p>
        <Button
          className="h-7 shrink-0 text-[12px]"
          data-cloud-join-restart
          disabled={restart.busy}
          onClick={restart.run}
          size="sm"
          variant="outline"
        >
          {restart.busy ? 'Restarting…' : 'Restart now'}
        </Button>
      </div>
      {restart.error && <p className="font-sans text-[12px] text-error">{restart.error}</p>}
      <div className="space-y-0.5">
        <div className="text-muted-foreground">
          {result.projects.length
            ? `${result.projects.length} ${result.projects.length === 1 ? 'project' : 'projects'} in the cloud`
            : 'No projects in the cloud yet'}
        </div>
        {result.projects.length > 0 && (
          <ul className="flex flex-wrap gap-1">
            {result.projects.map((project) => (
              <li
                className="rounded-sm border border-border/70 px-1.5 text-[10.5px] text-muted-foreground"
                key={project}
              >
                {project}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/** The form: cloud URL, machine name and the two secrets; the values live only here and go to `cloud.join`. */
function JoinForm({ state, onJoined }: { state: JoinState; onJoined: () => void }) {
  const [url, setUrl] = useState(state.url ?? '')
  const [machine, setMachine] = useState(state.machine)
  const [token, setToken] = useState('')
  const [snapshotKey, setSnapshotKey] = useState('')
  const [result, setResult] = useState<JoinResult | 'running'>()
  const running = result === 'running'
  const ready =
    !running && !!url.trim() && !!machine.trim() && !!token.trim() && !!snapshotKey.trim()
  const submit = async () => {
    if (running) return
    setResult('running')
    try {
      const outcome = await api.action(JoinAction, { url, machine, token, snapshotKey })
      setResult(outcome)
      if (outcome.ok) {
        setToken('')
        setSnapshotKey('')
        onJoined()
      }
    } catch (failure) {
      setResult({ ok: false, step: 'check', error: errorMessage(failure) })
    }
  }
  const done = result !== undefined && result !== 'running' && result.ok ? result : undefined
  const failed = result !== undefined && result !== 'running' && !result.ok ? result : undefined
  return (
    <>
      {!done && (
        // No <form>: browsers then don't offer to save the secrets as passwords (as in the Secrets panel).
        <div
          className="space-y-2 px-3 py-2"
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            // oxlint-disable-next-line typescript/no-floating-promises -- submit catches join failures and displays them in the result.
            if (ready) void submit()
          }}
        >
          <p className="font-sans text-[12px] text-muted-foreground">
            Use the values your other machines have. They go into Secrets on this machine, never
            into a conversation.
          </p>
          <Field label="Cloud URL" hint="wss:// or https://">
            <input
              aria-label="Cloud URL"
              className={field}
              disabled={running}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="wss://ultimate.example.com"
              spellCheck={false}
              value={url}
            />
          </Field>
          <Field label="Machine name">
            <input
              aria-label="Machine name"
              className={field}
              disabled={running}
              onChange={(event) => setMachine(event.target.value)}
              spellCheck={false}
              value={machine}
            />
          </Field>
          <Secret
            disabled={running}
            name="ULTIMATE_CLOUD_TOKEN"
            onChange={setToken}
            value={token}
          />
          <Secret
            disabled={running}
            name="ULTIMATE_CLOUD_SNAPSHOT_KEY"
            onChange={setSnapshotKey}
            value={snapshotKey}
          />
          <Button
            className="h-7 font-sans text-[12px]"
            disabled={!ready}
            onClick={() => void submit()}
            size="sm"
            type="button"
          >
            {running && <LoaderCircleIcon className="size-3.5 animate-spin" />}
            Join
          </Button>
        </div>
      )}
      {result !== undefined && (
        <div className="space-y-1.5 border-t border-border/60 px-3 py-2">
          <Steps result={result} />
          {failed && (
            <p
              className="font-sans text-[12px] leading-relaxed break-words text-error/90"
              data-cloud-join-error
              role="alert"
            >
              {failed.error}
            </p>
          )}
        </div>
      )}
      {done && <Next result={done} />}
    </>
  )
}

/**
 * Join cloud backups: on a machine without cloud backups, the form; once joined, "Joined as <machine> · <host>" with a
 * Change link that opens the form again.
 */
export function JoinCard() {
  const state = useAction(JoinStateAction)
  const [changing, setChanging] = useState(false)
  // The form stays mounted after its own join, to show the steps and the next block.
  const [joining, setJoining] = useState(false)
  const joined = state.data?.joined
  const form = !!state.data && (!joined || changing || joining)
  return (
    <section
      className="min-w-0 rounded-md border border-l-2 border-border border-l-brand/60 bg-card text-left font-mono text-[11.5px] shadow-xs"
      data-cloud-join={joined && !form ? 'joined' : 'form'}
    >
      <header className="flex min-w-0 items-center gap-2 py-1.5 pr-1.5 pl-3">
        <NetworkIcon className="size-3.5 shrink-0 text-brand" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/90">
          {joined && !form ? (
            <>
              Joined as {joined.machine}
              <span className="text-muted-foreground"> · {joined.host}</span>
            </>
          ) : (
            'Join cloud backups'
          )}
        </span>
        {joined && !form && (
          <Button
            className="h-5 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => setChanging(true)}
            size="xs"
            variant="ghost"
          >
            Change
          </Button>
        )}
      </header>
      {state.error && (
        <p className="border-t border-border/60 px-3 py-1.5 font-sans text-[12px] text-error/90">
          {errorMessage(state.error)}
        </p>
      )}
      {form && (
        <div className="border-t border-border/60">
          <JoinForm
            onJoined={() => {
              setJoining(true)
              // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
              void state.refetch()
            }}
            state={state.data!}
          />
        </div>
      )}
    </section>
  )
}

/** The "Join cloud backups" command's dialog. */
export function JoinDialog() {
  const [open, setOpen] = useDialog(joinDialog)
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent className="gap-0 p-0 sm:max-w-md" showCloseButton={false}>
        <DialogTitle className="sr-only">Join cloud backups</DialogTitle>
        <DialogDescription className="sr-only">
          Store the cloud URL, this machine's name and the two cloud secrets.
        </DialogDescription>
        <JoinCard />
      </DialogContent>
    </Dialog>
  )
}
