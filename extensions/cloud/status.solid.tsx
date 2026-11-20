/** @jsxImportSource @solidjs/web */
import { Cloud, LoaderCircle } from '@lucide/solid'
import { createSignal, Match, Show, Switch } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Popover, PopoverContent } from '@/components/ui/popover.solid.tsx'
import { StatusPopoverTrigger } from '@/components/ui/status-trigger.solid.tsx'
import {
  ROOT,
  api,
  cn,
  errorMessage,
  formatAgo,
  formatBytes,
  keepLast,
  useAction,
  useEvents,
} from '@/sdk/solid'
import { BackupAction, BackupEvent, StateAction } from './refs.ts'
import type { CloudState } from './types.ts'

const since = (at: number) => formatAgo(at, Date.now(), { ago: true })
const mb = (bytes: number) => {
  const value = bytes / 1024 / 1024
  return value < 10 ? value.toFixed(1) : String(Math.round(value))
}
const smallButton = 'h-6 font-sans text-[12px]'

function statusLabel(state: CloudState) {
  const status = state.backup
    ? 'backing up…'
    : state.conflict
      ? 'backup refused'
      : state.lastBackup
        ? `backed up ${since(state.lastBackup.at)}`
        : 'no backup yet'
  return state.chapter && state.chapter.number > 1
    ? `Chapter ${state.chapter.number} · ${state.chapter.name} · ${status}`
    : status
}

function backupDetails({ backup, lastBackup }: CloudState) {
  if (backup && backup.total > 0)
    return `${mb(backup.done)} / ${mb(backup.total)} MB read · ${mb(backup.uploaded)} MB uploaded`
  if (lastBackup)
    return `${since(lastBackup.at)} from ${lastBackup.machine} · ${formatBytes(lastBackup.uploaded)} (${formatBytes(lastBackup.bytes)} database)`
  return 'No backup from this machine yet'
}

function BackupRow(props: {
  state: CloudState
  busy: boolean
  backUp: () => Promise<void>
  error?: string
}) {
  return (
    <div class="space-y-1 px-3 py-2" data-cloud-backup>
      <div class="flex min-w-0 items-center gap-2">
        <span class="min-w-0 flex-1">
          <span class="block truncate text-[12px] text-foreground/90">
            {props.state.backup ? 'Backing up…' : 'Backup'}
          </span>
          <span
            class="block text-[11px] text-muted-foreground tabular-nums"
            title={props.state.lastBackup && new Date(props.state.lastBackup.at).toLocaleString()}
          >
            {backupDetails(props.state)}
          </span>
        </span>
        <Button
          class={smallButton}
          disabled={props.busy}
          onClick={() => props.backUp()}
          size="xs"
          title="Upload an encrypted snapshot of this project now"
          variant="outline"
        >
          <Show when={props.state.backup}>
            <LoaderCircle class="size-3 animate-spin" />
          </Show>
          Back up now
        </Button>
      </div>
      <Show when={props.state.backup}>
        {(backup) => (
          <progress
            aria-label="Cloud backup progress"
            class="block h-0.5 w-full appearance-none overflow-hidden rounded-full bg-muted [&::-moz-progress-bar]:bg-brand/70 [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-brand/70 [&::-webkit-progress-value]:transition-[width]"
            max={backup().total || 1}
            value={backup().total ? backup().done : 0}
          />
        )}
      </Show>
      <Show when={props.error}>
        <p class="font-sans text-[12px] text-error/90">{props.error}</p>
      </Show>
    </div>
  )
}

function replacementWarning(latest: NonNullable<CloudState['conflict']>['latest']) {
  const backup = latest
    ? `the backup ${latest.machine} made ${since(latest.at)} (${latest.id}) as the latest`
    : 'the latest backup from another machine'
  return `This replaces ${backup}. Its history stays in that backup until retention prunes it.`
}

function ConflictRow(props: {
  conflict: NonNullable<CloudState['conflict']>
  busy: boolean
  replace: () => Promise<void>
  error?: string
}) {
  const [confirming, setConfirming] = createSignal(false)
  const warning = () => replacementWarning(props.conflict.latest)
  return (
    <div class="space-y-1.5 border-t border-border/60 px-3 py-2" data-cloud-conflict>
      <p class="font-sans text-[12px] leading-relaxed text-warning">{props.conflict.error}</p>
      <Show
        when={confirming()}
        fallback={
          <div class="flex justify-end">
            <Button
              class={smallButton}
              disabled={props.busy}
              onClick={() => setConfirming(true)}
              size="xs"
              variant="outline"
            >
              Back up anyway
            </Button>
          </div>
        }
      >
        <p class="font-sans text-[12px] leading-relaxed text-muted-foreground">{warning()}</p>
        <div class="flex justify-end gap-1.5">
          <Button
            aria-label="Cancel backup replacement"
            class={smallButton}
            onClick={() => setConfirming(false)}
            size="xs"
            variant="ghost"
          >
            Cancel
          </Button>
          <Button
            aria-label="Replace the latest backup"
            class={smallButton}
            data-agent-confirm={warning()}
            disabled={props.busy}
            onClick={() => {
              setConfirming(false)
              return props.replace()
            }}
            size="xs"
            variant="destructive"
          >
            Replace it
          </Button>
        </div>
      </Show>
      <Show when={props.error}>
        <p class="font-sans text-[12px] text-error">{props.error}</p>
      </Show>
    </div>
  )
}

function CloudPopover(props: { state: CloudState; refetch: () => Promise<unknown> }) {
  const [pending, setPending] = createSignal(false)
  const [failure, setFailure] = createSignal<{ force: boolean; message: string }>()
  const busy = () => pending() || !!props.state.backup
  async function backUp(force: boolean) {
    if (busy()) return
    setPending(true)
    setFailure(undefined)
    try {
      await api.action(BackupAction, force ? { force } : null, { conversationId: ROOT })
    } catch (error) {
      setFailure({ force, message: errorMessage(error) })
    } finally {
      await props.refetch()
      setPending(false)
    }
  }
  const backupError = () =>
    !failure()?.force && !props.state.conflict
      ? (failure()?.message ?? props.state.lastError)
      : props.state.lastError

  return (
    <Popover onOpenChange={(open) => void (open && setFailure(undefined))}>
      <StatusPopoverTrigger
        aria-label="Cloud backup"
        class={cn(props.state.backup ? 'text-brand' : props.state.conflict && 'text-warning')}
        data-cloud-status
        title="Cloud backup"
      >
        <Show when={props.state.backup} fallback={<Cloud class="size-3" />}>
          <LoaderCircle class="size-3 animate-spin" />
        </Show>
        {statusLabel(props.state)}
      </StatusPopoverTrigger>
      <PopoverContent
        aria-label="Cloud backup details"
        align="end"
        class="w-80 max-w-[calc(100vw-1rem)] p-0 font-mono"
        side="top"
      >
        <BackupRow
          state={props.state}
          busy={busy()}
          backUp={() => backUp(false)}
          error={backupError()}
        />
        <Show when={props.state.conflict}>
          {(conflict) => (
            <ConflictRow
              busy={busy()}
              conflict={conflict()}
              error={failure()?.force ? failure()?.message : undefined}
              replace={() => backUp(true)}
            />
          )}
        </Show>
        <div class="border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
          Restore elsewhere with{' '}
          <code class="rounded-sm bg-muted px-1 py-0.5 text-foreground/85">
            pnpm restore {props.state.name}
          </code>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function CloudStatus() {
  const backups = useEvents({ events: [BackupEvent], limit: 1 })
  const { data, refetch } = useAction(StateAction, null, {
    conversation: ROOT,
    every: (state) => (state?.status === 'off' ? 30_000 : state?.backup ? 1_000 : 10_000),
    on: () => backups()?.[0]?.id,
    onError: keepLast,
  })
  return (
    <Switch>
      <Match when={data()?.status === 'local'}>
        <span
          class="flex items-center gap-1.5 text-muted-foreground/70"
          title="The project has no GitHub origin, so it is not backed up"
        >
          <Cloud class="size-3" />
          not backed up
        </span>
      </Match>
      <Match when={data()?.status === 'satellite'}>
        <span
          class="flex items-center gap-1.5 text-muted-foreground/70"
          title="This machine is a satellite (cloud.satellite): it never backs up, so it cannot replace another machine's backups"
        >
          <Cloud class="size-3" />
          satellite · no backups
        </span>
      </Match>
      <Match when={data()?.status === 'on' && data()}>
        {(state) => <CloudPopover state={state()} refetch={refetch} />}
      </Match>
    </Switch>
  )
}
