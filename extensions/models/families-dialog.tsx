/**
 * The model families dialog: each family's model, thinking and color at the top, then a board of everything that
 * calls a model (agent definitions, summaries, previews) in one column per family, moved by drag and drop or by each
 * card's menu, and the concurrency caps under Advanced. Saving writes it all at once; "Save all & switch running"
 * also moves conversations that run on a family's old model to its new one.
 */
import {
  AlertTriangleIcon,
  BotIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  GaugeIcon,
  LayersIcon,
  PinIcon,
  PlusIcon,
  SparklesIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import type { DragEvent, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandList,
} from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api, cn, errorMessage, useAction, useDialog, useModels } from '@/sdk'
import {
  BUILTIN_FAMILIES,
  DEFAULT_FAMILY,
  FAMILY_COLORS,
  familyColor,
  familyTitle,
  isFamilyName,
} from '../../lib/families.ts'
import { FamilyDot, familiesDialog, refreshFamilies } from './families.tsx'
import { ModelRow } from './picker.tsx'
import { FamiliesAction, SaveFamiliesAction } from './refs.ts'
import type { FamiliesView, FamilyLimits, FamilyUser, SaveFamilies } from './refs.ts'
import type { ModelInfo } from './state.tsx'

type Draft = SaveFamilies['families'][string]
/** A board column for users that keep the model they pin. */
const PINNED = ':pinned'
const DRAG_TYPE = 'text/x-ultimate-family-user'
const label = 'font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase'
const selectClass =
  'h-7 w-full min-w-0 rounded-md border border-border/80 bg-background px-1.5 font-mono text-[11.5px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50'

export function FamiliesDialog() {
  const [open, setOpen] = useDialog(familiesDialog)
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent
        className="flex h-[min(92vh,60rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl"
        showCloseButton={false}
      >
        {open && <Loader close={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function Loader({ close }: { close: () => void }) {
  const { data, error, refetch } = useAction(FamiliesAction, null)
  const [saved, setSaved] = useState<string>()
  if (!data)
    return (
      <>
        <DialogTitle className="sr-only">Model families</DialogTitle>
        <DialogDescription className="sr-only">Loading the model families</DialogDescription>
        <p className="m-auto font-mono text-[12px] text-muted-foreground">
          {error ? errorMessage(error) : 'Loading…'}
        </p>
      </>
    )
  return (
    <Editor
      close={close}
      key={JSON.stringify(data)}
      onSaved={async (message) => {
        setSaved(message)
        await Promise.all([refetch(), refreshFamilies()])
      }}
      saved={saved}
      view={data}
    />
  )
}

const choiceOf = (user: FamilyUser) => user.family ?? PINNED

const FROM: Record<FamiliesView['from'], string> = {
  project: "These are this project's.",
  recent:
    'This project has none of its own yet: these are the ones you saved last. Saving makes them its own.',
  builtin:
    'These are the built-in ones; saving makes them this project’s and the start for new projects.',
}

function Editor({
  view,
  close,
  saved,
  onSaved,
}: {
  view: FamiliesView
  close: () => void
  /** What the last save did, shown until the next change. */
  saved?: string
  onSaved: (message: string) => Promise<unknown>
}) {
  const models = useModels()
  const initialFamilies = useMemo(
    () =>
      Object.fromEntries(
        view.families.map((family) => [
          family.name,
          {
            ...(family.model ? { model: family.model } : {}),
            ...(family.thinking ? { thinking: family.thinking } : {}),
            color: family.color,
          },
        ]),
      ) as Record<string, Draft>,
    [view],
  )
  const initialChoices = useMemo(
    () => Object.fromEntries(view.users.map((user) => [user.id, choiceOf(user)])),
    [view],
  )
  const [families, setFamilies] = useState(initialFamilies)
  const [choices, setChoices] = useState<Record<string, string>>(initialChoices)
  const [limits, setLimits] = useState<FamilyLimits>(view.limits)
  const [pending, setPending] = useState<'save' | 'switch'>()
  const [error, setError] = useState<string>()
  const names = Object.keys(families)
  const dirty =
    JSON.stringify(families) !== JSON.stringify(initialFamilies) ||
    JSON.stringify(choices) !== JSON.stringify(initialChoices) ||
    JSON.stringify(limits) !== JSON.stringify(view.limits)
  const users = view.users
  const anyPinned = users.some((user) => user.pinned)
  const byChoice = Map.groupBy(users, (user) => choices[user.id] ?? choiceOf(user))
  const find = (ref: string | undefined) =>
    ref ? models?.models.find((model) => `${model.provider}/${model.id}` === ref) : undefined

  const setFamily = (name: string, change: Partial<Draft>) => {
    setFamilies((previous) => ({ ...previous, [name]: { ...previous[name], ...change } }))
    setError(undefined)
  }
  const move = (id: string, to: string) => {
    setChoices((previous) => ({ ...previous, [id]: to }))
    setError(undefined)
  }
  const removeFamily = (name: string) => {
    setFamilies(({ [name]: _removed, ...rest }) => rest)
    // Whoever ran on it goes back to where it would be without an assignment.
    setChoices((previous) =>
      Object.fromEntries(
        Object.entries(previous).map(([id, choice]) => {
          if (choice !== name) return [id, choice]
          const user = users.find((item) => item.id === id)
          const natural = user?.natural && user.natural !== name ? user.natural : DEFAULT_FAMILY
          return [id, user?.pinned ? PINNED : natural]
        }),
      ),
    )
  }

  async function save(switchRunning: boolean) {
    setPending(switchRunning ? 'switch' : 'save')
    setError(undefined)
    const known = new Set(users.map((user) => user.id))
    // Assignments of definitions not found now (another project's, a removed file) stay as they were.
    const assign: Record<string, string> = Object.fromEntries(
      Object.entries(view.assign).filter(([id, family]) => !known.has(id) && family in families),
    )
    const unpin: string[] = []
    for (const user of users) {
      if (user.project) continue
      const choice = choices[user.id] ?? choiceOf(user)
      if (choice === PINNED) continue
      if (user.pinned || choice !== user.natural) assign[user.id] = choice
      if (user.kind === 'feature' && user.pinned && user.pinnedIn?.startsWith('user'))
        unpin.push(user.id)
    }
    try {
      const { switched } = await api.action(SaveFamiliesAction, {
        families,
        assign,
        limits,
        unpin,
        switchRunning,
      })
      await onSaved(
        switchRunning
          ? `Saved · ${switched} conversation${switched === 1 ? '' : 's'} switched`
          : 'Saved · running conversations keep their models',
      )
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setPending(undefined)
    }
  }

  return (
    <>
      <header className="flex items-start gap-3 border-b border-border/70 px-5 py-3.5">
        <LayersIcon className="mt-0.5 size-4.5 shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <DialogTitle className="font-mono text-[14px] font-medium">Model families</DialogTitle>
          <DialogDescription className="mt-0.5 font-sans text-[12px] text-muted-foreground">
            Pick a model per family, then put each agent and feature in a family. Changing a
            family's model moves everything in it. {FROM[view.from]}
          </DialogDescription>
        </div>
        <Button
          aria-label="Close"
          className="size-7"
          onClick={close}
          size="icon-sm"
          variant="ghost"
        >
          <XIcon className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {view.errors.map((problem) => (
          <p
            className="flex items-start gap-2 rounded-md border border-error/30 bg-error/8 px-3 py-2 text-[12px] text-error"
            key={problem}
          >
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
            {problem}
          </p>
        ))}
        <section className="space-y-2">
          <div className={label}>Families</div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(12.5rem,1fr))] gap-2">
            {names.map((name) => (
              <FamilyCard
                count={byChoice.get(name)?.length ?? 0}
                draft={families[name]}
                follows={view.families.find((family) => family.name === name)}
                info={find(
                  families[name].model ??
                    view.families.find((family) => family.name === name)?.follows,
                )}
                key={name}
                name={name}
                onChange={(change) => setFamily(name, change)}
                onRemove={
                  Object.hasOwn(BUILTIN_FAMILIES, name) ? undefined : () => removeFamily(name)
                }
                project={view.families.find((family) => family.name === name)?.project}
              />
            ))}
            <AddFamily
              onAdd={(name) =>
                setFamilies((previous) => ({
                  ...previous,
                  [name]: {
                    color:
                      Object.keys(FAMILY_COLORS)[names.length % Object.keys(FAMILY_COLORS).length],
                  },
                }))
              }
              taken={names}
            />
          </div>
        </section>
        <section className="space-y-2">
          <div className="flex items-baseline gap-2">
            <span className={label}>Who runs on which</span>
            <span className="font-sans text-[11.5px] text-muted-foreground/80">
              drag a card to another family, or use its menu
            </span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(10.5rem,1fr))] gap-2">
            {[...names, ...(anyPinned ? [PINNED] : [])].map((column) => (
              <Column
                color={column === PINNED ? undefined : families[column].color}
                key={column}
                model={column === PINNED ? undefined : families[column].model}
                name={column}
                onDrop={(id) => {
                  const user = users.find((item) => item.id === id)
                  if (!user || user.project || (column === PINNED && !user.pinned)) return
                  move(id, column)
                }}
              >
                {(byChoice.get(column) ?? []).map((user) => (
                  <UserCard
                    changed={(choices[user.id] ?? choiceOf(user)) !== choiceOf(user)}
                    choice={choices[user.id] ?? choiceOf(user)}
                    families={names}
                    key={user.id}
                    onMove={(to) => move(user.id, to)}
                    user={user}
                  />
                ))}
              </Column>
            ))}
          </div>
        </section>
        <Advanced
          families={families}
          find={find}
          limits={limits}
          onChange={setLimits}
          pinned={users.flatMap((user) =>
            user.pinned && user.pinned !== 'off' ? [user.pinned.replace(/:[a-z]+$/, '')] : [],
          )}
        />
      </div>
      <footer className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/70 px-5 py-3">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {saved && !dirty ? (
            <span className="text-success">{saved}</span>
          ) : (
            'Saved for this project; new projects start from the families you saved last'
          )}
        </span>
        <Button className="h-7 px-3 text-[12px]" onClick={close} size="sm" variant="ghost">
          {dirty ? 'Cancel' : 'Close'}
        </Button>
        <Button
          className="h-7 px-3 text-[12px]"
          disabled={!dirty || pending !== undefined}
          onClick={() => void save(false)}
          size="sm"
          variant="outline"
        >
          {pending === 'save' ? 'Saving…' : 'Save all'}
        </Button>
        <Button
          className="h-7 px-3 text-[12px]"
          disabled={!dirty || pending !== undefined}
          onClick={() => void save(true)}
          size="sm"
          title="Save, and move conversations that run on a family's old model to its new one"
        >
          {pending === 'switch' ? 'Saving…' : 'Save all & switch running'}
        </Button>
        {error && (
          <p className="basis-full font-mono text-[11.5px] leading-snug break-words text-error">
            {error}
          </p>
        )}
      </footer>
    </>
  )
}

function FamilyCard({
  name,
  draft,
  info,
  follows,
  count,
  project,
  onChange,
  onRemove,
}: {
  name: string
  draft: Draft
  info: ModelInfo | undefined
  /** Pi's default model and thinking, for the default family. */
  follows?: { follows?: string; followsThinking?: string }
  count: number
  project?: true
  onChange: (change: Partial<Draft>) => void
  onRemove?: () => void
}) {
  const builtin = Object.hasOwn(BUILTIN_FAMILIES, name) ? BUILTIN_FAMILIES[name] : undefined
  const levels = info?.reasoning ? info.thinkingLevels : info ? ['off'] : []
  // A built-in level can be changed but not cleared: settings keep only what differs from the built-in.
  const inherit = !builtin?.thinking
  return (
    <div
      data-family-card={name}
      className="flex flex-col gap-2 rounded-md border border-border/80 border-t-2 bg-muted/15 px-2.5 pt-2 pb-2.5"
      style={{ borderTopColor: familyColor(draft.color) }}
    >
      <div className="flex items-center gap-1.5">
        <ColorPicker color={draft.color} onChange={(color) => onChange({ color })} />
        <span
          className="truncate font-mono text-[12.5px] font-medium"
          style={{ color: familyColor(draft.color) }}
        >
          {familyTitle(name)}
        </span>
        {project && <Tag title="The project's settings change this family">project</Tag>}
        <span className="ml-auto font-mono text-[10.5px] text-muted-foreground/70 tabular-nums">
          {count}
        </span>
        {onRemove && (
          <button
            aria-label={`Remove ${name}`}
            className="rounded p-0.5 text-muted-foreground/60 hover:bg-accent hover:text-error"
            onClick={onRemove}
            type="button"
          >
            <Trash2Icon className="size-3" />
          </button>
        )}
      </div>
      <div className="flex items-center gap-1">
        <ModelSelect
          onChange={(model) => onChange({ model })}
          placeholder={follows?.follows ? `Pi's default · ${follows.follows}` : undefined}
          value={draft.model}
        />
        {name === DEFAULT_FAMILY && draft.model && follows?.follows && (
          <button
            aria-label="Follow Pi's default model"
            className="shrink-0 rounded p-1 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
            onClick={() => onChange({ model: undefined })}
            title={`Follow Pi's default model (${follows.follows})`}
            type="button"
          >
            <XIcon className="size-3" />
          </button>
        )}
      </div>
      <select
        aria-label={`${name} thinking`}
        className={selectClass}
        onChange={(event) =>
          onChange({
            thinking:
              event.target.value === '' ? undefined : (event.target.value as Draft['thinking']),
          })
        }
        value={draft.thinking ?? ''}
      >
        {inherit && (
          <option value="">
            {name === DEFAULT_FAMILY && follows?.followsThinking
              ? `thinking · Pi's (${follows.followsThinking})`
              : 'thinking · inherit'}
          </option>
        )}
        {[...new Set([...levels, ...(draft.thinking ? [draft.thinking] : [])])].map((level) => (
          <option key={level} value={level}>
            thinking · {level}
          </option>
        ))}
      </select>
      <p className="font-sans text-[11px] leading-snug text-muted-foreground/80">
        {draft.model && info && !info.available ? (
          <span className="text-warning">
            No login for {info.provider}: its members run the default model.
          </span>
        ) : draft.model && !info ? (
          <span className="text-warning">
            Not in the model list here: its members run the default model.
          </span>
        ) : name === DEFAULT_FAMILY ? (
          'New conversations, @ultimate, branches; without a model it follows Pi’s default.'
        ) : (
          (FAMILY_HINTS[name] ?? 'A family of your own.')
        )}
      </p>
    </div>
  )
}

const FAMILY_HINTS: Record<string, string> = {
  slow: 'Deep, careful work: reviews.',
  fast: 'Bounded execution: workers, previews.',
  tiny: 'Quick, cheap calls: scouts, summaries.',
  design: 'Front-end and UI work.',
}

function ColorPicker({ color, onChange }: { color: string; onChange: (color: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-label="Family color"
          className="flex size-4 items-center justify-center rounded-full ring-offset-background hover:ring-2 hover:ring-ring/40"
          type="button"
        >
          <FamilyDot className="size-2.5" color={color} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid w-auto grid-cols-6 gap-1.5 p-2">
        {Object.keys(FAMILY_COLORS).map((name) => (
          <button
            aria-label={name}
            className={cn(
              'size-5 rounded-full ring-offset-2 ring-offset-popover',
              name === color && 'ring-2 ring-foreground/60',
            )}
            key={name}
            onClick={() => {
              onChange(name)
              setOpen(false)
            }}
            style={{ backgroundColor: familyColor(name) }}
            title={name}
            type="button"
          />
        ))}
      </PopoverContent>
    </Popover>
  )
}

function AddFamily({ taken, onAdd }: { taken: string[]; onAdd: (name: string) => void }) {
  const [name, setName] = useState('')
  const problem = !name
    ? undefined
    : !isFamilyName(name)
      ? 'lowercase letters, digits and -'
      : taken.includes(name)
        ? 'exists already'
        : undefined
  const add = () => {
    if (!name || problem) return
    onAdd(name)
    setName('')
  }
  return (
    <div className="flex flex-col gap-2 rounded-md border border-dashed border-border/80 px-2.5 py-2">
      <div className="flex items-center gap-1.5 font-mono text-[12px] text-muted-foreground">
        <PlusIcon className="size-3.5" />
        New family
      </div>
      <input
        aria-invalid={problem ? true : undefined}
        aria-label="New family name"
        className={cn(selectClass, 'px-2')}
        onChange={(event) => setName(event.target.value.trim().toLowerCase())}
        onKeyDown={(event) => {
          if (event.key === 'Enter') add()
        }}
        placeholder="local"
        spellCheck={false}
        value={name}
      />
      {problem ? (
        <p className="font-sans text-[11px] text-error">{problem}</p>
      ) : (
        <Button
          className="h-7 text-[12px]"
          disabled={!name}
          onClick={add}
          size="sm"
          variant="outline"
        >
          Add
        </Button>
      )}
    </div>
  )
}

function Column({
  name,
  color,
  model,
  onDrop,
  children,
}: {
  name: string
  color?: string
  model?: string
  onDrop: (id: string) => void
  children: ReactNode
}) {
  const [over, setOver] = useState(false)
  const accept = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setOver(true)
  }
  return (
    <div
      className={cn(
        'flex min-h-28 flex-col gap-1.5 rounded-md border bg-muted/10 p-1.5 transition-colors',
        over ? 'border-ring/70 bg-accent/40' : 'border-border/60',
      )}
      data-family-column={name}
      onDragEnter={accept}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false)
      }}
      onDragOver={accept}
      onDrop={(event) => {
        event.preventDefault()
        setOver(false)
        const id = event.dataTransfer.getData(DRAG_TYPE)
        if (id) onDrop(id)
      }}
    >
      <div className="flex min-w-0 items-center gap-1.5 px-1 pt-0.5 pb-1 font-mono text-[11.5px]">
        {name === PINNED ? (
          <>
            <PinIcon className="size-3 shrink-0 text-muted-foreground" />
            <span className="text-muted-foreground">Pinned model</span>
          </>
        ) : (
          <>
            <FamilyDot color={color} />
            <span className="shrink-0" style={{ color: familyColor(color) }}>
              {familyTitle(name)}
            </span>
            <span className="truncate text-[10.5px] text-muted-foreground/70">
              {model ? model.slice(model.indexOf('/') + 1) : ''}
            </span>
          </>
        )}
      </div>
      {children}
    </div>
  )
}

function UserCard({
  user,
  choice,
  families,
  changed,
  onMove,
}: {
  user: FamilyUser
  choice: string
  families: string[]
  changed: boolean
  onMove: (to: string) => void
}) {
  const Icon = user.kind === 'agent' ? BotIcon : SparklesIcon
  const locked = !!user.project
  return (
    <div
      className={cn(
        'group rounded border border-border/70 bg-background px-2 py-1.5 shadow-xs',
        locked ? 'opacity-70' : 'cursor-grab active:cursor-grabbing',
      )}
      data-family-user={user.id}
      draggable={!locked}
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_TYPE, user.id)
        event.dataTransfer.effectAllowed = 'move'
      }}
      title={[
        user.description,
        user.pinned && `pins ${user.pinned} in ${user.pinnedIn}`,
        locked && "set in the project's settings",
      ]
        .filter(Boolean)
        .join('\n')}
    >
      <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11.5px]">
        <Icon className="size-3 shrink-0 text-muted-foreground" />
        <span className="truncate text-foreground/90">{user.label}</span>
        {changed && (
          <span aria-label="changed" className="size-1.5 shrink-0 rounded-full bg-brand" />
        )}
        {user.source && user.source !== 'builtin' && <Tag>{user.source}</Tag>}
      </div>
      {choice === PINNED && user.pinned && (
        <div className="mt-0.5 truncate pl-4.5 font-mono text-[10.5px] text-muted-foreground/80">
          {user.pinned}
        </div>
      )}
      <select
        aria-label={`${user.label} family`}
        className={cn(selectClass, 'mt-1 h-6 text-[11px]')}
        disabled={locked}
        onChange={(event) => onMove(event.target.value)}
        value={choice}
      >
        {families.map((name) => (
          <option key={name} value={name}>
            {familyTitle(name)}
          </option>
        ))}
        {user.pinned && <option value={PINNED}>Pinned · {user.pinned}</option>}
      </select>
    </div>
  )
}

function Advanced({
  families,
  pinned,
  limits,
  find,
  onChange,
}: {
  families: Record<string, Draft>
  /** Models agents and features pin, which a cap can hold too. */
  pinned: string[]
  limits: FamilyLimits
  find: (ref: string | undefined) => ModelInfo | undefined
  onChange: (limits: FamilyLimits) => void
}) {
  const capped =
    Object.values(limits.models).filter((limit) => limit > 0).length + (limits.global ? 1 : 0)
  const listed = [
    ...new Set([
      ...Object.values(families)
        .map((family) => family.model)
        .filter((model): model is string => !!model),
      ...pinned,
      ...Object.keys(limits.models),
    ]),
  ]
  const familiesOf = (model: string) =>
    Object.entries(families)
      .filter(([, family]) => family.model === model)
      .map(([name, family]) => ({ name, color: family.color }))
  const setModel = (model: string, value: number | undefined) => {
    const { [model]: _old, ...rest } = limits.models
    onChange({ ...limits, models: value ? { ...rest, [model]: value } : rest })
  }
  return (
    <Collapsible className="rounded-md border border-border/60">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left">
        <ChevronRightIcon className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <GaugeIcon className="size-3.5 text-muted-foreground" />
        <span className={label}>Advanced · concurrency</span>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground/80">
          {capped ? `${capped} cap${capped === 1 ? '' : 's'}` : 'unlimited'}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 border-t border-border/60 px-3 py-3">
        <p className="font-sans text-[12px] leading-snug text-muted-foreground">
          Requests over a cap wait for a free slot, first come first served. Almost always
          unlimited; cap a local model that serves only a few sessions at a time.
        </p>
        <div className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-x-3 gap-y-1.5">
          <span className="font-mono text-[12px]">All models together</span>
          <LimitInput
            label="Global cap"
            onChange={(global) => onChange({ ...limits, global })}
            value={limits.global}
          />
          {listed.map((model) => (
            <Fragment key={model}>
              <span className="flex min-w-0 items-center gap-2 font-mono text-[12px]">
                <span className="truncate">
                  <span className="text-muted-foreground">
                    {model.slice(0, model.indexOf('/') + 1)}
                  </span>
                  {model.slice(model.indexOf('/') + 1)}
                </span>
                {familiesOf(model).map((family) => (
                  <span
                    className="flex shrink-0 items-center gap-1 text-[10.5px] text-muted-foreground"
                    key={family.name}
                  >
                    <FamilyDot color={family.color} />
                    {familyTitle(family.name)}
                  </span>
                ))}
                {!find(model) && <span className="text-[10.5px] text-warning">unknown</span>}
              </span>
              <LimitInput
                label={`${model} cap`}
                onChange={(value) => setModel(model, value)}
                value={limits.models[model]}
              />
            </Fragment>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11.5px] text-muted-foreground">Cap another model</span>
          <div className="w-72">
            <ModelSelect
              onChange={(model) => {
                if (model && !listed.includes(model)) setModel(model, 4)
              }}
              placeholder="pick a model…"
              value={undefined}
            />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function LimitInput({
  value,
  label: name,
  onChange,
}: {
  value: number | undefined
  label: string
  onChange: (value: number | undefined) => void
}) {
  return (
    <input
      aria-label={name}
      className={cn(selectClass, 'text-right tabular-nums')}
      min={0}
      onChange={(event) => {
        const next = Number.parseInt(event.target.value, 10)
        onChange(Number.isFinite(next) && next > 0 ? next : undefined)
      }}
      placeholder="unlimited"
      step={1}
      type="number"
      value={value ?? ''}
    />
  )
}

const LIMIT = 150

/** A searchable model choice, as the model picker lists them: logged-in ones until you type. */
function ModelSelect({
  value,
  placeholder = 'pick a model',
  onChange,
}: {
  value: string | undefined
  placeholder?: string
  onChange: (value: string) => void
}) {
  const models = useModels()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const groups = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const all = models?.models ?? []
    const found = terms.length
      ? all.filter((model) =>
          terms.every((term) =>
            `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(term),
          ),
        )
      : all.filter((model) => model.available || `${model.provider}/${model.id}` === value)
    return [
      ...Map.groupBy(
        found.toSorted((a, b) => Number(b.available) - Number(a.available)).slice(0, LIMIT),
        (model) => model.provider,
      ),
    ]
  }, [models, query, value])
  const slash = value?.indexOf('/') ?? -1
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          className={cn(selectClass, 'flex items-center gap-1 text-left')}
          title={value}
          type="button"
        >
          {value ? (
            <span className="min-w-0 truncate">
              <span className="text-muted-foreground">{value.slice(0, slash + 1)}</span>
              {value.slice(slash + 1)}
            </span>
          ) : (
            <span className="min-w-0 truncate text-muted-foreground">{placeholder}</span>
          )}
          <ChevronsUpDownIcon className="ml-auto size-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(34rem,90vw)] p-0">
        <Command
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:uppercase"
          shouldFilter={false}
          {...(value ? { defaultValue: value } : {})}
        >
          <CommandInput
            className="text-[13px]"
            onValueChange={setQuery}
            placeholder={`Search ${(models?.models.length ?? 0).toLocaleString()} models…`}
            value={query}
          />
          <CommandList className="max-h-[45vh]">
            <CommandEmpty className="py-6 text-center text-[12px] text-muted-foreground">
              No model matches.
            </CommandEmpty>
            {groups.map(([provider, items]) => (
              <CommandGroup heading={provider} key={provider}>
                {items.map((model) => (
                  <ModelRow
                    current={`${model.provider}/${model.id}` === value}
                    key={`${model.provider}/${model.id}`}
                    model={model}
                    onSelect={() => {
                      onChange(`${model.provider}/${model.id}`)
                      setOpen(false)
                      setQuery('')
                    }}
                  />
                ))}
              </CommandGroup>
            ))}
          </CommandList>
          <div className="border-t border-border/70 px-3 py-1.5 text-[11px] text-muted-foreground">
            {query ? 'all providers' : 'logged-in providers · type to search all'}
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function Tag({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      className="shrink-0 rounded border border-border/80 px-1 font-mono text-[9.5px] tracking-wide text-muted-foreground uppercase"
      title={title}
    >
      {children}
    </span>
  )
}
