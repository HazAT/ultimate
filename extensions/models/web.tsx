import { BrainIcon, CheckIcon, ChevronDownIcon, CpuIcon } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Kbd } from '@/components/ui/kbd'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  api,
  cn,
  defineWebExtension,
  errorMessage,
  getConversation,
  getState,
  useDialog,
  useTranscript,
  useUltimate,
} from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { LoginDialog } from './login.tsx'
import { FamiliesDialog } from './families-dialog.tsx'
import {
  FamilyDot,
  familiesDialog,
  familyOf,
  ModelLabel,
  modelLabel,
  runsOn,
  useFamilies,
} from './families.tsx'
import type { FamilyView } from './refs.ts'
import { familyColor, familyTitle } from '../../lib/families.ts'
import { ModelPicker } from './picker.tsx'
import { nextThinking, openLogin, openPicker, thinkingDialog, useCurrentModel } from './state.tsx'
import type { ThinkingLevel } from './state.tsx'
import { switchAt } from './switches.ts'
import type { Fallback } from './refs.ts'

const toolbarButton =
  'flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-md px-2 font-mono text-[11.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground'

/**
 * The composer's model button: a menu of the families first (which one this conversation runs on, who else does, a
 * cap), then a specific model through the picker, and the families editor.
 */
function ModelButton() {
  const { id, ref, thinking, loading, models } = useCurrentModel()
  const actions = useUltimate()
  const families = useFamilies()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string>()
  const current = familyOf(families, ref, thinking)
  const choose = (family: FamilyView) => {
    const model = runsOn(family)
    const slash = model?.indexOf('/') ?? -1
    if (!model) return
    setError(undefined)
    api
      .configure(
        {
          model: { provider: model.slice(0, slash), modelId: model.slice(slash + 1) },
          ...((family.thinking ?? family.followsThinking)
            ? { thinkingLevel: family.thinking ?? family.followsThinking }
            : {}),
        },
        id,
      )
      .then(
        () => setOpen(false),
        (failure: unknown) => setError(errorMessage(failure)),
      )
  }
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          className={cn(toolbarButton, 'min-w-0 shrink')}
          disabled={loading}
          aria-label={loading ? 'Loading model' : undefined}
          title={
            loading
              ? 'Loading model'
              : ref
                ? `${modelLabel(families, ref, thinking)} · ${ref.provider} — pick a family or model`
                : 'Pick a model'
          }
          type="button"
        >
          <CpuIcon className="size-3.5 shrink-0" />
          {loading || !ref ? (
            <span className={cn('truncate', loading ? undefined : 'text-warning')}>
              {loading ? 'model…' : 'no model'}
            </span>
          ) : (
            <ModelLabel className="text-foreground/85" model={ref} thinking={thinking} />
          )}
          <ChevronDownIcon className="size-3 shrink-0 opacity-60 @max-md:hidden" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[26rem] p-0 font-mono" side="top">
        <div className="px-3 pt-2.5 pb-1 text-[10.5px] tracking-wider text-muted-foreground uppercase">
          This conversation runs on
        </div>
        <div className="px-1 pb-1">
          {(families?.families ?? []).map((family) => {
            const model = runsOn(family)
            const info = models?.models.find((item) => `${item.provider}/${item.id}` === model)
            const members = families?.users.filter((user) => user.family === family.name) ?? []
            const cap = model ? families?.limits.models[model] : undefined
            const usable = !!info?.available
            return (
              <button
                className="grid w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-accent disabled:opacity-50 disabled:hover:bg-transparent"
                disabled={!usable}
                key={family.name}
                onClick={() => choose(family)}
                title={usable ? model : `${model ?? 'No model'}: no login here`}
                type="button"
              >
                <CheckIcon
                  className={cn(
                    'size-3.5',
                    current?.name === family.name ? 'text-brand' : 'opacity-0',
                  )}
                />
                <span className="flex min-w-0 items-center gap-1.5 text-[12px]">
                  <FamilyDot color={family.color} />
                  <span style={{ color: familyColor(family.color) }}>
                    {familyTitle(family.name)}
                  </span>
                  <span className="truncate text-muted-foreground">
                    {model ? model.slice(model.indexOf('/') + 1) : 'no model'}
                    {(family.thinking ?? family.followsThinking) &&
                      ` · ${family.thinking ?? family.followsThinking}`}
                  </span>
                </span>
                <span className="text-[10.5px] text-muted-foreground/70">
                  {!usable ? 'no login' : cap ? `≤${cap}` : ''}
                </span>
                <span className="col-start-2 truncate text-[10.5px] text-muted-foreground/60">
                  {members.map((user) => user.label).join(' · ') || '—'}
                </span>
              </button>
            )
          })}
          <button
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            key="pick"
            onClick={() => {
              setOpen(false)
              openPicker(actions)
            }}
            type="button"
          >
            <span className="w-3.5" />A specific model…
          </button>
        </div>
        <div className="flex items-center gap-3 border-t border-border/70 px-3 py-1.5 text-[11px] text-muted-foreground">
          {error ? (
            <span className="truncate text-error">{error}</span>
          ) : (
            <>
              <span className="truncate">Switches this conversation only</span>
              <button
                className="ml-auto shrink-0 hover:text-foreground"
                onClick={() => {
                  setOpen(false)
                  actions.open(familiesDialog)
                }}
                type="button"
              >
                Edit families…
              </button>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ThinkingButton() {
  const { id, model, thinking, loading } = useCurrentModel()
  const [open, setOpen] = useDialog(thinkingDialog(id))
  const [error, setError] = useState<string>()
  if (loading)
    return (
      <button
        className={toolbarButton}
        disabled
        aria-label="Loading thinking level"
        title="Loading thinking level"
        type="button"
      >
        <BrainIcon className="size-3.5 shrink-0" />
        <span>thinking…</span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-60 @max-md:hidden" />
      </button>
    )
  if (!model?.reasoning) return null
  const levels = model.thinkingLevels
  const current = thinking ?? 'off'
  const choose = (level: ThinkingLevel) => {
    setError(undefined)
    api.configure({ thinkingLevel: level }, id).then(
      () => setOpen(false),
      (failure: unknown) => setError(errorMessage(failure)),
    )
  }
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button className={toolbarButton} title="Thinking level (Shift+Tab cycles)" type="button">
          <BrainIcon className={cn('size-3.5 shrink-0', current !== 'off' && 'text-brand')} />
          <span className={current !== 'off' ? 'text-foreground/85' : undefined}>{current}</span>
          <ChevronDownIcon className="size-3 shrink-0 opacity-60 @max-md:hidden" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 p-1 font-mono" side="top">
        <div className="px-2 pt-1 pb-1.5 text-[10.5px] tracking-wider text-muted-foreground uppercase">
          Thinking
        </div>
        {levels.map((level) => (
          <button
            className={cn(
              'flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-[12px] transition-colors hover:bg-accent',
              level === current && 'text-brand',
            )}
            key={level}
            onClick={() => choose(level)}
            type="button"
          >
            <CheckIcon className={cn('size-3.5', level !== current && 'opacity-0')} />
            {level}
          </button>
        ))}
        <div className="mt-1 flex items-center gap-1.5 border-t border-border/70 px-2 pt-1.5 pb-1 text-[11px] text-muted-foreground">
          {error ? (
            <span className="text-error">{error}</span>
          ) : (
            <>
              <Kbd>⇧ Tab</Kbd> cycles
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** "Fast (gpt-6-luna)" for a model a family runs, else the model as the divider names it. */
const named = (families: ReturnType<typeof useFamilies>, ref: string, shown: string) => {
  const label = modelLabel(families, ref)
  return label === ref.slice(ref.indexOf('/') + 1) ? shown : label
}

/** A response that ran on another model or thinking level than the one before it, marked above it. */
function Switched({ entry, core }: { entry: EntryRecord; core: ReactNode }) {
  const change = switchAt(useTranscript(), entry)
  const families = useFamilies()
  if (!change) return core
  const Icon = change.model ? CpuIcon : BrainIcon
  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground/70 before:h-px before:flex-1 before:bg-border/70 after:h-px after:flex-1 after:bg-border/70"
        data-models-switch
        title="The model and thinking level from this response on"
      >
        <span className="flex max-w-[80%] min-w-0 items-center gap-1.5">
          <Icon className="size-3 shrink-0" />
          <span className="truncate">
            {[
              change.model &&
                `${named(families, change.model.fromRef, change.model.from)} → ${named(families, change.model.toRef, change.model.to)}`,
              change.thinking && `thinking ${change.thinking.from} → ${change.thinking.to}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
      </div>
      {core}
    </div>
  )
}

const switchedTo: Record<Exclude<Fallback['reason'], 'none'>, string> = {
  same: 'the same model through another login',
  pin: 'the model its agent definition pins',
  default: 'the default model',
}

/**
 * A conversation whose model had no login here switched to another as its next run started, or, with no subscription
 * login to replace it, kept its model and waits for the user.
 */
function FellBack({ entry }: { entry: EntryRecord }) {
  const { from, to, reason } = entry.data as Fallback
  const actions = useUltimate()
  const families = useFamilies()
  const provider = from.split('/')[0]
  return (
    <section
      className="min-w-0 rounded-md border border-border border-l-2 border-l-warning/60 bg-muted/20"
      data-models-fallback
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <CpuIcon className="size-3.5 text-warning" />
        <span>{to ? 'model switched' : 'needs you · login missing'}</span>
      </header>
      <div className="space-y-2 px-3 py-3 text-[13px] leading-relaxed">
        <p className="font-mono text-[12px]">
          {to ? (
            <>
              <span className="text-muted-foreground line-through">
                {named(families, from, from)}
              </span>
              {' → '}
              <span className="text-foreground">{named(families, to, to)}</span>
            </>
          ) : (
            <span className="text-foreground">{named(families, from, from)}</span>
          )}
        </p>
        <p className="text-muted-foreground">
          {reason !== 'none'
            ? `${provider} has no login here, so this conversation now runs on ${switchedTo[reason]}.`
            : `${provider} has no login here, and no subscription login can take over, so this conversation keeps its model and its requests fail until you log in to ${provider}.`}{' '}
          <button
            className="cursor-pointer text-foreground hover:underline"
            onClick={() => openPicker(actions)}
            type="button"
          >
            Pick another
          </button>{' '}
          or{' '}
          <button
            className="cursor-pointer text-foreground hover:underline"
            onClick={() => openLogin(actions)}
            type="button"
          >
            log in
          </button>
          .
        </p>
      </div>
    </section>
  )
}

export default defineWebExtension({
  entries: { 'pi.assistant': Switched, 'models.fallback': FellBack },
  slots: {
    'composer.toolbar': [ModelButton, ThinkingButton],
    overlay: [ModelPicker, LoginDialog, FamiliesDialog],
  },
  commands: [
    {
      id: 'model.families',
      title: 'Model families…',
      run: (context) => context.open(familiesDialog),
    },
    {
      id: 'model.pick',
      title: 'Pick a model',
      run: (context) => {
        if (!getConversation(context.conversationId).loading) openPicker(context)
      },
    },
    {
      id: 'model.thinking',
      title: 'Set the thinking level',
      run: (context) => context.open(thinkingDialog(context.conversationId)),
    },
    {
      id: 'model.thinking.cycle',
      title: 'Cycle the thinking level',
      keys: 'shift+tab',
      whileTyping: true,
      // Shift+Tab in a side chat's composer cycles the side chat's level, not main's.
      run: async (context) => {
        const { agent, loading } = getConversation(context.conversationId)
        if (loading) return undefined
        const ref = agent.model
        const thinking = agent.thinkingLevel
        const model = getState().models?.models.find(
          (candidate) => candidate.provider === ref?.provider && candidate.id === ref.modelId,
        )
        if (!model?.reasoning) return undefined
        return api.configure(
          { thinkingLevel: nextThinking(thinking, model) },
          context.conversationId,
        )
      },
    },
    {
      id: 'auth.login',
      title: 'Log in to a provider',
      run: (context) => openLogin(context),
    },
  ],
})
