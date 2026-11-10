import { BlocksIcon, CheckIcon, FolderCogIcon, GitBranchIcon, LoaderCircleIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  api,
  attention,
  Card,
  defineWebExtension,
  errorMessage,
  useAction,
  useConversation,
  useDialog,
  useDocOf,
  useEvent,
  useExtensions,
  useSystem,
  useTranscript,
  useUltimate,
} from '@/sdk'
import type { EntryRecord, ToolCallView } from '@/sdk'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FirstRun, GitCard, ProjectCard, Recommended } from './pages.tsx'
import { IsolationAction } from '../workspaces/ui.tsx'
import { StartComposer } from './survey.tsx'
import { ExtensionsPanel } from './panel.tsx'
import { firstRunDialog, gitDialog, projectDialog } from './parts.tsx'
import {
  ChooseAction,
  HelpAction,
  StartAction,
  StartsDoc,
  StatusAction,
  WalkthroughAction,
} from './refs.ts'

function useIsolation() {
  const workspaces = useExtensions().some((extension) => extension.name === 'workspaces')
  // A run may have set up Git: read again when one ends.
  const busy = useConversation((conversation) => conversation.busy)
  const [runs, setRuns] = useState({ busy, ended: 0 })
  if (busy !== runs.busy) setRuns({ busy, ended: runs.ended + (busy ? 0 : 1) })
  const isolation = useAction(IsolationAction, null, { enabled: workspaces, on: runs.ended })
  useEvent('onboarding:git', () => {
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    if (workspaces) void isolation.refetch()
  })
  return workspaces ? isolation.data : undefined
}

async function askUltimate(card: 'project' | 'git') {
  const { id } = await api.action(HelpAction, { card })
  return id
}

function Onboarding() {
  const status = useAction(StatusAction)
  const ui = useUltimate()
  const [finished, setFinished] = useState(false)
  // Existing panel/start-page entry points now ask @ultimate too; no setup dialogs remain.
  const [projectOpen, setProjectOpen] = useDialog(projectDialog)
  const [gitOpen, setGitOpen] = useDialog(gitDialog)
  const [again, setAgain] = useDialog(firstRunDialog)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!projectOpen && !gitOpen) return
    setProjectOpen(false)
    setGitOpen(false)
    void askUltimate(projectOpen ? 'project' : 'git')
      .then((id) => {
        ui.switchConversation(id)
        ui.showSurface('agent')
      })
      .catch((failure) => setError(errorMessage(failure)))
  }, [projectOpen, gitOpen, setProjectOpen, setGitOpen, ui])
  return (
    <>
      <FirstRun
        open={again || (!navigator.webdriver && status.data?.firstRun === true && !finished)}
        onClosed={() => ui.focusComposer()}
        onDone={async (skipped) => {
          if (!skipped) {
            const { id } = await api.action(StartAction, {})
            ui.switchConversation(id)
            ui.showSurface('agent')
          }
          setFinished(true)
          setAgain(false)
        }}
      />
      {error && (
        <div className="fixed right-4 bottom-12" role="alert">
          <button
            className="cursor-pointer rounded border border-error/40 bg-card p-3 text-left text-xs text-error"
            onClick={() => setError(undefined)}
            title="Dismiss"
            type="button"
          >
            {error}
          </button>
        </div>
      )}
    </>
  )
}

function SetupLink({
  card,
  off,
  children,
}: {
  card: 'project' | 'git'
  off?: boolean
  children: string
}) {
  const ui = useUltimate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const click = async () => {
    if (busy) return
    // With onboarding off, the decision is the user's own: the Extensions panel shows it.
    if (off) return ui.openPanel('extensions')
    setBusy(true)
    try {
      ui.switchConversation(await askUltimate(card))
      ui.showSurface('agent')
      setError(undefined)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  const Icon = card === 'project' ? FolderCogIcon : GitBranchIcon
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          disabled={busy}
          className="-mx-1 flex items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => void click()}
          type="button"
        >
          <Icon className="size-3 text-brand" />
          {error ?? children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-[11px]">
        {error ??
          (off ? "Decide on this project's setup." : 'Ask @ultimate for help with this folder.')}
      </TooltipContent>
    </Tooltip>
  )
}
/** Dismissing Start here quiets the setup reminders too; ⌘K Get ready… and the Extensions panel still reach them. */
const useDismissed = () => useDocOf(1, StartsDoc)?.dismissed === true
const useOff = () => useAction(StatusAction).data?.off === true
function Undecided() {
  const project = useSystem()?.project
  const dismissed = useDismissed()
  // With onboarding off nothing else asks, so an undecided `.ultimate/` keeps its reminder.
  const off = useOff()
  return (off || !dismissed) && project?.config && project.decision === null ? (
    <SetupLink card="project" off={off}>
      project setup
    </SetupLink>
  ) : null
}
function NoGit() {
  const reason = useIsolation()?.reason
  const dismissed = useDismissed()
  const off = useOff()
  return reason && !dismissed && !off ? <SetupLink card="git">set up git</SetupLink> : null
}

type Choice = { card: string; summary: string; toolCallId: string }
function SetupCall({ call }: { call: ToolCallView }) {
  const transcript = useTranscript()
  const conversationId = useConversation((conversation) => conversation.id)
  const status = useAction(StatusAction)
  const isolation = useIsolation()
  const card = typeof call.args.card === 'string' ? call.args.card : ''
  const entry = transcript.find(
    (candidate) =>
      candidate.kind === 'onboarding.choice' && (candidate.data as Choice).toolCallId === call.id,
  )
  const settled = (entry?.data as Choice | undefined)?.summary
  const done = async (payload: {
    extensions?: Record<string, boolean>
    local?: boolean
    initialize?: boolean
  }) => {
    await api.action(ChooseAction, { card, ...payload, toolCallId: call.id }, { conversationId })
  }
  if (!['extensions', 'project', 'git'].includes(card)) return null
  const title =
    card === 'extensions'
      ? 'Recommended extensions'
      : card === 'project'
        ? "Use this project's setup?"
        : 'Set up Git for this folder?'
  return (
    <Card
      attention={!settled && call.status !== 'error'}
      className="overflow-hidden"
      data-setup-card={card}
    >
      <header className="border-b border-border px-4 py-2.5 font-mono text-xs text-muted-foreground">
        {title}
      </header>
      {call.status === 'error' ? (
        <p className="p-4 text-xs text-error">
          {call.diagnostics.find((item) => item.severity === 'error')?.message ?? call.output}
        </p>
      ) : settled ? (
        <p className="flex items-start gap-2 p-4 text-sm">
          <CheckIcon className="size-4 shrink-0 text-brand" />
          <span>Chosen: {settled}</span>
        </p>
      ) : call.status !== 'done' ? (
        <p className="p-4 text-xs text-muted-foreground">
          {call.status === 'interrupted'
            ? 'Setup was interrupted. Ask @ultimate to show this card again.'
            : 'Checking…'}
        </p>
      ) : card === 'extensions' ? (
        <Recommended status={status.data} onDone={done} />
      ) : card === 'project' ? (
        <ProjectCard adds={status.data?.adds} onDone={done} />
      ) : (
        <GitCard isolation={isolation} onDone={done} />
      )}
    </Card>
  )
}
function ChoiceCard({ entry }: { entry: EntryRecord }) {
  const data = entry.data as Choice
  return (
    <section className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
      <span className="font-mono">Setup choice · {data.card}</span>
      <p className="mt-1 text-foreground/85">{data.summary}</p>
    </section>
  )
}

/** Whether @ultimate has said anything to the user since `entry`: text, or a message call. */
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

/**
 * The start of onboarding or the walkthrough: while @ultimate prepares its first message, a card that says what is
 * happening; afterwards a quiet record of when it started.
 */
function StartCard({
  entry,
  title,
  preparing: text,
  instructions,
}: {
  entry: EntryRecord
  title: string
  /** What @ultimate is doing until its first message. */
  preparing: string
  instructions?: string
}) {
  const busy = useConversation((conversation) => conversation.busy)
  const transcript = useTranscript()
  const preparing = busy && !spokeSince(transcript, entry)
  return preparing ? (
    <Card className="flex items-start gap-3 px-4 py-3">
      <LoaderCircleIcon className="mt-0.5 size-4 shrink-0 animate-spin text-brand" />
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">Getting ready…</p>
        <p className="text-sm text-muted-foreground">{text}</p>
        {instructions && <Instructions text={instructions} />}
      </div>
    </Card>
  ) : (
    <section className="text-xs text-muted-foreground">
      <p className="flex items-center gap-2">
        <CheckIcon className="size-3.5 shrink-0 text-brand/70" />
        {title}
      </p>
      {instructions && (
        <div className="mt-1 pl-5.5">
          <Instructions text={instructions} />
        </div>
      )}
    </section>
  )
}

function Instructions({ text }: { text: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      Your instructions: <span className="whitespace-pre-wrap text-foreground/85">{text}</span>
    </p>
  )
}

export default defineWebExtension({
  tools: { setup: attention(SetupCall) },
  // Until onboarding has run, @ultimate's composer carries the card that starts it.
  composer: StartComposer,
  entries: {
    'onboarding.choice': ChoiceCard,
    // Marked `attention` so the start stays in @ultimate's thread instead of folding into the stretch before its first
    // message: it is all a newcomer sees while that first turn runs (#554687).
    'onboarding.start': attention(({ entry }) => (
      <StartCard
        entry={entry}
        instructions={(entry.data as { instructions?: string }).instructions}
        title="Onboarding started"
        preparing="@ultimate is reading your project. In a moment it starts a short walkthrough of how Ultimate works, with a few questions you answer here."
      />
    )),
    'walkthrough.start': attention(({ entry }) => (
      <StartCard
        entry={entry}
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
