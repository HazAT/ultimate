import {
  BlocksIcon,
  CheckIcon,
  FolderCogIcon,
  GitBranchIcon,
  LoaderCircleIcon,
} from '@lucide/solid'
import { dynamic } from '@solidjs/web'
import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { StatusButton } from '@/components/ui/status-trigger.solid.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.solid.tsx'
import {
  Card,
  renderEntry,
  api,
  attention,
  defineWebExtension,
  errorMessage,
  events,
  openPanel,
  ROOT,
  showSurface,
  switchConversation,
  useAction,
  useConversation,
  useConversationId,
  useDialog,
  useDocOf,
  useEvent,
  useExtensions,
  useSystem,
  useTranscript,
  writerNow,
  writingAs,
  type EntryRecord,
  type SolidToolProps,
} from '@/sdk/solid'
import { ListAction } from '../secrets/refs.ts'
import { IsolationAction } from '../workspaces/refs.ts'
import { settledChoice } from './choices.ts'
import { firstRunDialog, gitDialog, projectDialog } from './dialogs.ts'
import { ChoiceEntry, StartEntry } from './entries.ts'
import { FirstRun, GitCard, ProjectCard, Recommended } from './pages.solid.tsx'
import { ExtensionsPanel } from './panel.solid.tsx'
import {
  ChooseAction,
  HelpAction,
  StartAction,
  StartsDoc,
  StatusAction,
  WalkthroughAction,
} from './refs.ts'
import { StartComposer } from './survey.solid.tsx'

function useIsolation() {
  const conversation = useConversation()
  const busy = createMemo(() => conversation().busy)
  const [ended, setEnded] = createSignal(0)
  createEffect(busy, (working, wasWorking) => {
    if (wasWorking && !working) setEnded((count) => count + 1)
  })
  const isolation = useAction(IsolationAction, null, { conversation: ROOT, on: ended })
  useEvent('onboarding:git', () => void isolation.refetch())
  return isolation.data
}

function IsolationReminder() {
  const isolation = useIsolation()
  const dismissed = useDismissed()
  const off = useOff()
  return (
    <Show when={isolation()?.reason && !dismissed() && !off()}>
      <SetupLink card="git">set up git</SetupLink>
    </Show>
  )
}

const useWorkspaces = () => {
  const extensions = useExtensions()
  return () => extensions().some((extension) => extension.name === 'workspaces')
}

function NoGit() {
  const workspaces = useWorkspaces()
  return (
    <Show when={workspaces()}>
      <IsolationReminder />
    </Show>
  )
}

async function askUltimate(card: 'project' | 'git') {
  const { id } = await api.action(HelpAction, { card })
  switchConversation(id)
  showSurface('agent')
}

function Onboarding() {
  const status = useAction(StatusAction, null, { conversation: ROOT })
  const [finished, setFinished] = createSignal(false)
  const [projectOpen, setProjectOpen] = useDialog(projectDialog)
  const [gitOpen, setGitOpen] = useDialog(gitDialog)
  const [again, setAgain] = useDialog(firstRunDialog)
  const [error, setError] = createSignal<string>()
  createEffect(
    () => (projectOpen() ? 'project' : gitOpen() ? 'git' : undefined),
    (card) => {
      if (!card) return
      setProjectOpen(false)
      setGitOpen(false)
      void askUltimate(card).catch((failure) => setError(errorMessage(failure)))
    },
  )
  const finish = async (skipped: boolean) => {
    const source = writerNow()
    const id = skipped ? undefined : (await api.action(StartAction, {})).id
    writingAs(source, () => {
      if (id !== undefined) {
        switchConversation(id)
        showSurface('agent')
      }
      setFinished(true)
      setAgain(false)
    })
  }
  return (
    <>
      <FirstRun
        open={again() || (!navigator.webdriver && status.data()?.firstRun === true && !finished())}
        onDone={finish}
      />
      <Show when={error()}>
        <div class="fixed right-4 bottom-12" role="alert">
          <Button
            size={null}
            variant={null}
            aria-label="Dismiss setup error"
            class="rounded border border-error/40 bg-card p-3 text-left text-xs font-normal text-error"
            onClick={() => setError(undefined)}
            title="Dismiss"
          >
            {error()}
          </Button>
        </div>
      </Show>
    </>
  )
}

function SetupLink(props: { card: 'project' | 'git'; off?: boolean; children: string }) {
  const [error, setError] = createSignal<string>()
  const click = async () => {
    if (props.off) return openPanel('extensions')
    try {
      await askUltimate(props.card)
      setError(undefined)
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }
  const icon = createMemo(() => (props.card === 'project' ? FolderCogIcon : GitBranchIcon))
  const Icon = dynamic(icon)
  return (
    <Tooltip delay={400}>
      <TooltipTrigger
        render={(trigger) => <StatusButton {...trigger} />}
        aria-label={props.children}
        onClick={click}
      >
        <Icon class="size-3 text-brand" />
        {error() ?? props.children}
      </TooltipTrigger>
      <TooltipContent side="top" class="text-[11px]">
        {error() ??
          (props.off
            ? "Decide on this project's setup."
            : 'Ask @ultimate for help with this folder.')}
      </TooltipContent>
    </Tooltip>
  )
}

const useDismissed = () => {
  const starts = useDocOf(() => ROOT, StartsDoc)
  return () => starts()?.dismissed === true
}
const useOff = () => {
  const status = useAction(StatusAction, null, { conversation: ROOT })
  return () => status.data()?.off === true
}
function Undecided() {
  const system = useSystem()
  const project = () => system()?.project
  const dismissed = useDismissed()
  const off = useOff()
  return (
    <Show when={(off() || !dismissed()) && project()?.config && project()?.decision === null}>
      <SetupLink card="project" off={off()}>
        project setup
      </SetupLink>
    </Show>
  )
}

function SetupCall(props: SolidToolProps) {
  const transcript = useTranscript()
  const conversationId = useConversationId()
  const status = useAction(StatusAction, null, { conversation: ROOT })
  const workspaces = useWorkspaces()
  const system = useSystem()
  const call = () => props.call
  const card = () => {
    const name = call().args.card
    return typeof name === 'string' ? name : ''
  }
  const entry = () =>
    transcript()
      .filter((candidate) => ChoiceEntry.is(candidate))
      .find((candidate) => candidate.data.toolCallId === call().id)
  const settled = createMemo(() =>
    settledChoice(card(), entry()?.data.summary, system()?.project?.decision),
  )
  const done = async (payload: {
    extensions?: Record<string, boolean>
    local?: boolean
    initialize?: boolean
  }) => {
    await api.action(
      ChooseAction,
      { card: card(), ...payload, toolCallId: call().id },
      {
        conversationId: conversationId(),
      },
    )
  }
  const title = () =>
    card() === 'extensions'
      ? 'Recommended extensions'
      : card() === 'project'
        ? "Use this project's setup?"
        : 'Set up Git for this folder?'
  return (
    <Show when={['extensions', 'project', 'git'].includes(card())}>
      <Card
        attention={!settled() && call().status !== 'error'}
        class="overflow-hidden"
        data-setup-card={card()}
      >
        <header class="border-b border-border px-4 py-2.5 font-mono text-xs text-muted-foreground">
          {title()}
        </header>
        <Switch>
          <Match when={call().status === 'error'}>
            <p class="p-4 text-xs text-error">
              {call().diagnostics.find((item) => item.severity === 'error')?.message ??
                call().output}
            </p>
          </Match>
          <Match when={settled()}>
            <p class="flex items-start gap-2 p-4 text-sm">
              <CheckIcon class="size-4 shrink-0 text-brand" />
              <span>Chosen: {settled()}</span>
            </p>
            <Show when={entry()?.data.missing?.length}>
              <MissingKeys names={entry()!.data.missing!} id={call().id} />
            </Show>
          </Match>
          <Match when={call().status !== 'done'}>
            <p class="p-4 text-xs text-muted-foreground">
              {call().status === 'interrupted'
                ? 'Setup was interrupted. Ask @ultimate to show this card again.'
                : 'Checking…'}
            </p>
          </Match>
          <Match when={card() === 'extensions'}>
            <Recommended status={status.data()} onDone={done} id={call().id} />
          </Match>
          <Match when={card() === 'project'}>
            <ProjectCard adds={status.data()?.adds} onDone={done} id={call().id} />
          </Match>
          <Match when={card() === 'git'}>
            <Show when={workspaces()} fallback={<GitCard onDone={done} id={call().id} />}>
              <GitSetup onDone={done} id={call().id} />
            </Show>
          </Match>
        </Switch>
      </Card>
    </Show>
  )
}

function MissingKeys(props: { names: readonly string[]; id: string }) {
  const secrets = useAction(ListAction, null, { conversation: ROOT })
  useEvent('secrets:changed', () => void secrets.refetch())
  const isSet = (name: string) =>
    secrets.data()?.some((secret) => secret.name === name && (secret.set || secret.via))
  return (
    <ul class="space-y-1.5 border-t border-border/70 px-4 py-3">
      <For each={props.names} keyed={(name) => name}>
        {(name) => (
          <li class="flex items-center gap-2 text-xs">
            <span class="min-w-0 flex-1 truncate font-mono text-foreground/85">{name()}</span>
            <Show
              when={isSet(name())}
              fallback={
                <>
                  <span class="text-warning">missing</span>
                  <Button
                    aria-label={`Add secret ${name()} (setup ${props.id})`}
                    class="h-6 px-2 text-[11px]"
                    onClick={() => events.emit('secrets:open', { name: name() })}
                    size="sm"
                    variant="outline"
                  >
                    Add
                  </Button>
                </>
              }
            >
              <span class="text-muted-foreground">set</span>
            </Show>
          </li>
        )}
      </For>
    </ul>
  )
}

function GitSetup(props: {
  onDone: (choice: { initialize: boolean }) => Promise<void>
  id: string
}) {
  const isolation = useIsolation()
  return <GitCard isolation={isolation()} onDone={props.onDone} id={props.id} />
}

const ChoiceCard = renderEntry(ChoiceEntry, (props) => (
  <section class="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
    <span class="font-mono">Setup choice · {props.entry.data.card}</span>
    <p class="mt-1 text-foreground/85">{props.entry.data.summary}</p>
  </section>
))

const spokeSince = (transcript: readonly EntryRecord[], entry: EntryRecord) =>
  transcript.some((later) => {
    const message = later.model?.[0]
    return (
      later.id > entry.id &&
      message?.role === 'assistant' &&
      message.content.some(
        (block) =>
          (block.type === 'text' && block.text.trim()) ||
          (block.type === 'toolCall' && block.name === 'message'),
      )
    )
  })

function StartCard(props: {
  entry: EntryRecord
  title: string
  preparing: string
  instructions?: string
}) {
  const conversation = useConversation()
  const transcript = useTranscript()
  return (
    <Show
      when={conversation().busy && !spokeSince(transcript(), props.entry)}
      fallback={
        <section class="text-xs text-muted-foreground">
          <p class="flex items-center gap-2">
            <CheckIcon class="size-3.5 shrink-0 text-brand/70" />
            {props.title}
          </p>
          <Show when={props.instructions}>
            {(instructions) => (
              <div class="mt-1 pl-5.5">
                <Instructions text={instructions()} />
              </div>
            )}
          </Show>
        </section>
      }
    >
      <Card class="flex items-start gap-3 px-4 py-3">
        <LoaderCircleIcon class="mt-0.5 size-4 shrink-0 animate-spin text-brand" />
        <div class="min-w-0 space-y-1">
          <p class="text-sm font-medium">Getting ready…</p>
          <p class="text-sm text-muted-foreground">{props.preparing}</p>
          <Show when={props.instructions}>
            {(instructions) => <Instructions text={instructions()} />}
          </Show>
        </div>
      </Card>
    </Show>
  )
}

function Instructions(props: { text: string }) {
  return (
    <p class="text-xs text-muted-foreground">
      Your instructions: <span class="whitespace-pre-wrap text-foreground/85">{props.text}</span>
    </p>
  )
}

export default defineWebExtension({
  tools: { setup: attention(SetupCall) },
  composer: StartComposer,
  entries: {
    'onboarding.choice': ChoiceCard,
    'onboarding.start': attention(
      renderEntry(StartEntry, (props) => (
        <StartCard
          entry={props.entry}
          instructions={props.entry.data.instructions}
          title="Onboarding started"
          preparing="@ultimate is reading your project. In a moment it starts a short walkthrough of how Ultimate works, with a few questions you answer here."
        />
      )),
    ),
    'walkthrough.start': attention((props) => (
      <StartCard
        entry={props.entry}
        title="Walkthrough started"
        preparing="@ultimate is preparing a short walkthrough of how Ultimate works, with a few questions you answer here."
      />
    )),
  },
  slots: {
    overlay: [Onboarding],
    'statusline.right': [
      { component: NoGit, phone: true },
      { component: Undecided, phone: true },
    ],
  },
  panels: [
    {
      id: 'extensions',
      title: 'Extensions',
      icon: BlocksIcon,
      component: ExtensionsPanel,
      order: 8,
    },
  ],
  commands: [
    {
      id: 'onboarding.extensions',
      title: 'Extensions…',
      run: (context) => context.openPanel('extensions'),
    },
    {
      id: 'onboarding.first-run',
      title: 'Get ready…',
      run: (context) => context.open(firstRunDialog),
    },
    {
      id: 'onboarding.walkthrough',
      title: 'Walk me through Ultimate',
      run: async (context) => {
        const { id } = await api.action(WalkthroughAction)
        context.switchConversation(id)
        context.showSurface('agent')
      },
    },
  ],
})
