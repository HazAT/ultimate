/** @jsxImportSource @solidjs/web */
import { Check, Circle, Copy, LoaderCircle, Network, X } from '@lucide/solid'
import { createMemo, createSignal, For, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog.solid.tsx'
import { Form } from '@/components/ui/form.solid.tsx'
import { Input, SecretInput } from '@/components/ui/input.solid.tsx'
import { ROOT, api, cn, errorMessage, useAction, useCopy, useDialog, useRestart } from '@/sdk/solid'
import { JoinAction, JoinStateAction } from './refs.ts'
import type { JoinResult, JoinState } from './refs.ts'

export const joinDialog = 'cloud.join'

const steps = ['Check cloud', 'Save secrets', 'Save settings', 'Done']
const failedAt = { check: 0, secrets: 1, settings: 2 }
const stepIcon = {
  pending: () => <Circle class="size-2 shrink-0 text-muted-foreground/40" />,
  running: () => <LoaderCircle class="size-3 shrink-0 animate-spin text-brand" />,
  done: () => <Check class="size-3 shrink-0 text-success/70" />,
  failed: () => <X class="size-3 shrink-0 text-error" />,
}

function stepState(result: JoinResult | 'running', index: number) {
  if (result === 'running') return index === 0 ? 'running' : 'pending'
  if (result.ok || index < failedAt[result.step]) return 'done'
  return index === failedAt[result.step] ? 'failed' : 'pending'
}

function Steps(props: { result: JoinResult | 'running' }) {
  const error = () => props.result !== 'running' && !props.result.ok && props.result.error
  return (
    <div class="space-y-1.5 border-t border-border/60 px-3 py-2">
      <ol class="space-y-0.5" data-cloud-join-steps>
        <For each={steps}>
          {(label, index) => {
            const phase = () => stepState(props.result, index())
            return (
              <li
                class={cn(
                  'flex min-w-0 items-center gap-2 leading-5',
                  phase() === 'running'
                    ? 'text-brand'
                    : phase() === 'pending'
                      ? 'text-muted-foreground/60'
                      : 'text-muted-foreground',
                )}
              >
                <span class="flex w-3 shrink-0 justify-center">{stepIcon[phase()]()}</span>
                {label}
              </li>
            )
          }}
        </For>
      </ol>
      <Show when={error()}>
        <p
          class="font-sans text-[12px] leading-relaxed break-words text-error/90"
          data-cloud-join-error
          role="alert"
        >
          {error()}
        </p>
      </Show>
    </div>
  )
}

function Next(props: { projects: string[] }) {
  const restart = useRestart()
  const { copied, copy } = useCopy()
  const count = () => props.projects.length
  return (
    <div class="space-y-2 border-t border-border/60 px-3 py-2" data-cloud-join-next>
      <div class="text-foreground/85">Next</div>
      <div class="space-y-1">
        <p class="font-sans text-[12px] text-muted-foreground">
          In the Ultimate clone, so Ultimate starts at login:
        </p>
        <Button
          aria-label="Copy pnpm setup:machine"
          class="group flex w-full items-center gap-2 rounded-md border border-border/80 bg-background px-2 py-1.5 text-left text-foreground/90 transition-colors outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => copy('pnpm setup:machine')}
          size={null}
          title="Copy"
          variant={null}
        >
          <span class="text-muted-foreground/60 select-none">$</span>
          <code class="min-w-0 flex-1 break-all">pnpm setup:machine</code>
          <Show
            when={copied()}
            fallback={
              <Copy class="size-3.5 shrink-0 text-muted-foreground/60 group-hover:text-foreground" />
            }
          >
            <Check class="size-3.5 shrink-0 text-success" />
          </Show>
        </Button>
      </div>
      <div class="flex items-start gap-3">
        <p class="flex-1 font-sans text-[12px] text-muted-foreground">
          Backups read <code>cloud.url</code> and the secrets from the next start on. Restart this
          Ultimate now, and any other running project from its own page.
        </p>
        <Button
          aria-label="Restart Ultimate for cloud backups"
          class="h-7 shrink-0 text-[12px]"
          data-agent-confirm="Restarts the shared Ultimate host."
          data-cloud-join-restart
          disabled={restart.busy()}
          onClick={restart.run}
          size="sm"
          variant="outline"
        >
          {restart.busy() ? 'Restarting…' : 'Restart now'}
        </Button>
      </div>
      <Show when={restart.error()}>
        <p class="font-sans text-[12px] text-error">{restart.error()}</p>
      </Show>
      <div class="space-y-0.5">
        <div class="text-muted-foreground">
          {count()
            ? `${count()} ${count() === 1 ? 'project' : 'projects'} in the cloud`
            : 'No projects in the cloud yet'}
        </div>
        <Show when={count()}>
          <ul class="flex flex-wrap gap-1">
            <For each={props.projects}>
              {(project) => (
                <li class="rounded-sm border border-border/70 px-1.5 text-[10.5px] text-muted-foreground">
                  {project}
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  )
}

const secretNames = {
  token: 'ULTIMATE_CLOUD_TOKEN',
  snapshotKey: 'ULTIMATE_CLOUD_SNAPSHOT_KEY',
}

function JoinForm(props: { state: JoinState; onJoined: () => void }) {
  const [url, setUrl] = createSignal(() => props.state.url ?? '')
  const [machine, setMachine] = createSignal(() => props.state.machine)
  const [token, setToken] = createSignal('')
  const [snapshotKey, setSnapshotKey] = createSignal('')
  const [result, setResult] = createSignal<JoinResult | 'running'>()
  const running = () => result() === 'running'
  const done = createMemo(() => {
    const value = result()
    return value !== 'running' && value?.ok ? value : undefined
  })
  const [mayHaveWrittenSecrets, setMayHaveWrittenSecrets] = createSignal(false)
  const replacing = () =>
    mayHaveWrittenSecrets() || props.state.missing.length < Object.keys(secretNames).length
  const ready = () =>
    !running() && [url(), machine(), token(), snapshotKey()].every((value) => value.trim())

  async function submit() {
    if (!ready()) return
    const earlierAttemptMayHaveWritten = mayHaveWrittenSecrets()
    setResult('running')
    setMayHaveWrittenSecrets(true)
    try {
      const outcome = await api.action(
        JoinAction,
        { url: url(), machine: machine(), token: token(), snapshotKey: snapshotKey() },
        { conversationId: ROOT },
      )
      setResult(outcome)
      const nothingWritten = !outcome.ok && outcome.step === 'check'
      if (nothingWritten && !earlierAttemptMayHaveWritten) setMayHaveWrittenSecrets(false)
      if (outcome.ok) {
        setToken('')
        setSnapshotKey('')
        props.onJoined()
      }
    } catch (failure) {
      setResult({ ok: false, step: 'check', error: errorMessage(failure) })
    }
  }

  return (
    <div class="border-t border-border/60">
      <Show when={!done()}>
        <Form class="space-y-2 px-3 py-2">
          <p class="font-sans text-[12px] text-muted-foreground">
            Use the values your other machines have. They go into Secrets on this machine, never
            into a conversation.
          </p>
          <label class="block space-y-1">
            <span class="flex items-baseline gap-2 text-muted-foreground">
              Cloud URL <span class="text-muted-foreground/60">wss:// or https://</span>
            </span>
            <Input
              aria-label="Cloud URL"
              disabled={running()}
              onValueChange={setUrl}
              placeholder="wss://ultimate.example.com"
              value={url()}
            />
          </label>
          <label class="block space-y-1 text-muted-foreground">
            <span class="block">Machine name</span>
            <Input
              class="text-foreground"
              disabled={running()}
              onValueChange={setMachine}
              value={machine()}
            />
          </label>
          <For
            each={[
              { label: secretNames.token, value: token, setValue: setToken },
              { label: secretNames.snapshotKey, value: snapshotKey, setValue: setSnapshotKey },
            ]}
          >
            {(field) => (
              <div class="space-y-1">
                <div class="text-muted-foreground">{field.label}</div>
                <SecretInput
                  aria-label={field.label}
                  disabled={running()}
                  onValueChange={field.setValue}
                  placeholder="Paste the value the other machines use"
                  value={field.value()}
                />
              </div>
            )}
          </For>
          <Button
            class="h-7 font-sans text-[12px]"
            data-agent-confirm={
              replacing()
                ? 'Replaces the cloud secrets stored on this machine and its cloud URL and name.'
                : undefined
            }
            disabled={!ready()}
            onClick={submit}
            size="sm"
            type="submit"
          >
            <Show when={running()}>
              <LoaderCircle class="size-3.5 animate-spin" />
            </Show>
            Save cloud connection
          </Button>
        </Form>
      </Show>
      <Show when={result()}>{(outcome) => <Steps result={outcome()} />}</Show>
      <Show when={done()}>{(outcome) => <Next projects={outcome().projects} />}</Show>
    </div>
  )
}

function JoinCard() {
  const state = useAction(JoinStateAction, null, { conversation: ROOT })
  const [editing, setEditing] = createSignal(false)
  const joined = () => (editing() ? undefined : state.data()?.joined)
  return (
    <section
      class="min-w-0 rounded-md border border-l-2 border-border border-l-brand/60 bg-card text-left font-mono text-[11.5px] shadow-xs"
      data-cloud-join={joined() ? 'joined' : 'form'}
    >
      <header class="flex min-w-0 items-center gap-2 py-1.5 pr-1.5 pl-3">
        <Network class="size-3.5 shrink-0 text-brand" />
        <span class="min-w-0 flex-1 truncate text-[12px] text-foreground/90">
          <Show when={joined()} fallback="Join cloud backups">
            {(current) => (
              <>
                Joined as {current().machine}
                <span class="text-muted-foreground/60"> · {current().host}</span>
              </>
            )}
          </Show>
        </span>
        <Show when={joined()}>
          <Button
            aria-label="Change cloud settings"
            class="h-5 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => setEditing(true)}
            size="xs"
            variant="ghost"
          >
            Change
          </Button>
        </Show>
      </header>
      <Show when={state.error()}>
        {(error) => (
          <p class="border-t border-border/60 px-3 py-1.5 font-sans text-[12px] text-error/90">
            {errorMessage(error())}
          </p>
        )}
      </Show>
      <Show when={!joined() && state.data()}>
        {(data) => (
          <JoinForm
            state={data()}
            onJoined={() => {
              setEditing(true)
              void state.refetch()
            }}
          />
        )}
      </Show>
    </section>
  )
}

export function JoinDialog() {
  const [open, setOpen] = useDialog(joinDialog)
  return (
    <Dialog onOpenChange={setOpen} open={open()}>
      <DialogContent class="gap-0 p-0 sm:max-w-md" showCloseButton={false}>
        <DialogTitle class="sr-only">Join cloud backups</DialogTitle>
        <DialogDescription class="sr-only">
          Store the cloud URL, this machine's name and the two cloud secrets.
        </DialogDescription>
        <JoinCard />
      </DialogContent>
    </Dialog>
  )
}
