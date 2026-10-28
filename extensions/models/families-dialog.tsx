/**
 * The model families editor, one matrix: each family is a column. Its first rows are the family's settings (model,
 * thinking, and under More settings the concurrency cap), so another setting is another row; below them, every
 * agent definition and feature is a row with one dot per family, and clicking a dot moves it there. Apply saves it
 * all and, ticked, moves open conversations still on a family's old model to the new one.
 */
import {
  AlertTriangleIcon,
  BotIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  LayersIcon,
  PinIcon,
  PlusIcon,
  SparklesIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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

type Draft = SaveFamilies['families'][string]
/** The choice of a row that keeps the model its definition or setting pins. */
const PINNED = ':pinned'
const label = 'font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase'
const selectClass =
  'h-7 w-full min-w-0 rounded-md border border-border/80 bg-background px-1.5 font-mono text-[11.5px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50'
const choiceOf = (user: FamilyUser) => user.family ?? PINNED
const FROM: Record<FamiliesView['from'], string> = {
  project: "This project's families.",
  recent: 'This project has none of its own yet: these are the ones you saved last.',
  builtin:
    'The built-in families; applying makes them this project’s and the start for new projects.',
}

export function FamiliesDialog() {
  const [open, setOpen] = useDialog(familiesDialog)
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent
        className="flex max-h-[min(92vh,60rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl"
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
        <p className="m-auto py-16 font-mono text-[12px] text-muted-foreground">
          {error ? errorMessage(error) : 'Loading…'}
        </p>
      </>
    )
  return (
    <Matrix
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

/** The model and thinking a row runs on, as the draft stands: what a change of it is measured by. */
function runsOf(
  families: Record<string, Draft>,
  view: FamiliesView,
  choice: string,
  user: FamilyUser,
) {
  if (choice === PINNED) return `pin ${user.pinned}`
  const family = families[choice]
  const follows = view.families.find((item) => item.name === choice)
  return `${family?.model ?? follows?.follows ?? ''} ${family?.thinking ?? follows?.followsThinking ?? ''}`
}

function Matrix({
  view,
  close,
  saved,
  onSaved,
}: {
  view: FamiliesView
  close: () => void
  /** What the last apply did, shown until the next change. */
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
  const [more, setMore] = useState(
    () => !!view.limits.global || Object.keys(view.limits.models).length > 0,
  )
  const [switchRunning, setSwitchRunning] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const names = Object.keys(families)
  const users = view.users
  const find = (ref: string | undefined) =>
    ref ? models?.models.find((model) => `${model.provider}/${model.id}` === ref) : undefined
  const choice = (user: FamilyUser) => choices[user.id] ?? choiceOf(user)

  const changedFamilies = names.filter(
    (name) => JSON.stringify(families[name]) !== JSON.stringify(initialFamilies[name]),
  )
  const removedFamilies = Object.keys(initialFamilies).filter((name) => !(name in families))
  const movedUsers = users.filter((user) => choice(user) !== choiceOf(user))
  const limitsChanged = JSON.stringify(limits) !== JSON.stringify(view.limits)
  const changes =
    changedFamilies.length + removedFamilies.length + movedUsers.length + (limitsChanged ? 1 : 0)
  // Open conversations whose model or thinking the draft changes: what "switch" would move.
  const affected =
    users.reduce(
      (sum, user) =>
        runsOf(families, view, choice(user), user) ===
        runsOf(initialFamilies, view, choiceOf(user), user)
          ? sum
          : sum + (view.open[user.id] ?? 0),
      0,
    ) +
    (JSON.stringify(families[DEFAULT_FAMILY]) === JSON.stringify(initialFamilies[DEFAULT_FAMILY])
      ? 0
      : (view.open[DEFAULT_FAMILY] ?? 0))

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
        Object.entries(previous).map(([id, current]) => {
          if (current !== name) return [id, current]
          const user = users.find((item) => item.id === id)
          const natural = user?.natural && user.natural !== name ? user.natural : DEFAULT_FAMILY
          return [id, user?.pinned ? PINNED : natural]
        }),
      ),
    )
  }
  const discard = () => {
    setFamilies(initialFamilies)
    setChoices(initialChoices)
    setLimits(view.limits)
    setError(undefined)
  }

  async function apply() {
    setPending(true)
    setError(undefined)
    const known = new Set(users.map((user) => user.id))
    // Assignments of definitions not found now (a removed file) stay as they were.
    const assign: Record<string, string> = Object.fromEntries(
      Object.entries(view.assign).filter(([id, family]) => !known.has(id) && family in families),
    )
    const unpin: string[] = []
    for (const user of users) {
      if (user.project) continue
      const chosen = choice(user)
      if (chosen === PINNED) continue
      if (user.pinned || chosen !== user.natural) assign[user.id] = chosen
      if (user.kind === 'feature' && user.pinned && user.pinnedIn?.startsWith('user'))
        unpin.push(user.id)
    }
    const switching = switchRunning && affected > 0
    try {
      const { switched } = await api.action(SaveFamiliesAction, {
        families,
        assign,
        limits,
        unpin,
        switchRunning: switching,
      })
      await onSaved(
        switching
          ? `Applied · ${switched} conversation${switched === 1 ? '' : 's'} switched`
          : 'Applied',
      )
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setPending(false)
    }
  }

  const sharedWith = (name: string) =>
    names.filter(
      (other) =>
        other !== name && families[other].model && families[other].model === families[name].model,
    )
  const columns = names.length + 2
  const groups: [string, FamilyUser[]][] = [
    ['Agents', users.filter((user) => user.kind === 'agent')],
    ['Features', users.filter((user) => user.kind === 'feature')],
  ]
  const cell = 'border-b border-border/50 px-1.5 py-1.5 align-middle'

  return (
    <>
      <header className="flex items-start gap-3 border-b border-border/70 px-5 py-3.5">
        <LayersIcon className="mt-0.5 size-4.5 shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <DialogTitle className="font-mono text-[14px] font-medium">Model families</DialogTitle>
          <DialogDescription className="mt-0.5 font-sans text-[12px] text-muted-foreground">
            Each column is a family: its model and settings on top, who runs on it below.{' '}
            {FROM[view.from]}
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
      <div className="min-h-0 flex-1 overflow-auto px-5 pt-1 pb-4">
        {view.errors.map((problem) => (
          <p
            className="mt-3 flex items-start gap-2 rounded-md border border-error/30 bg-error/8 px-3 py-2 text-[12px] text-error"
            key={problem}
          >
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
            {problem}
          </p>
        ))}
        <table
          className="w-full table-fixed border-separate border-spacing-0 text-[12px]"
          style={{ minWidth: `${15 + names.length * 8 + 2.5}rem` }}
        >
          <colgroup>
            <col style={{ width: '15rem' }} />
            {names.map((name) => (
              <col key={name} />
            ))}
            <col style={{ width: '2.5rem' }} />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-background">
            <tr>
              <th className={cn(cell, 'pt-3')} />
              {names.map((name) => (
                <th className={cn(cell, 'pt-3 text-left')} key={name}>
                  <FamilyHeader
                    color={families[name].color}
                    name={name}
                    onColor={(color) => setFamily(name, { color })}
                    onRemove={
                      Object.hasOwn(BUILTIN_FAMILIES, name) ? undefined : () => removeFamily(name)
                    }
                    project={view.families.find((family) => family.name === name)?.project}
                  />
                </th>
              ))}
              <th className={cn(cell, 'pt-3')}>
                <AddFamily
                  onAdd={(name) =>
                    setFamilies((previous) => ({
                      ...previous,
                      [name]: {
                        color:
                          Object.keys(FAMILY_COLORS)[
                            names.length % Object.keys(FAMILY_COLORS).length
                          ],
                      },
                    }))
                  }
                  taken={names}
                />
              </th>
            </tr>
          </thead>
          <tbody>
            <SettingRow cell={cell} label="Model">
              {names.map((name) => {
                const follows = view.families.find((family) => family.name === name)?.follows
                const info = find(families[name].model ?? follows)
                return (
                  <td className={cell} key={name}>
                    <div className="flex items-center gap-0.5">
                      <ModelSelect
                        onChange={(model) => setFamily(name, { model })}
                        placeholder={
                          follows ? `Pi · ${follows.slice(follows.indexOf('/') + 1)}` : undefined
                        }
                        value={families[name].model}
                      />
                      {name === DEFAULT_FAMILY && families[name].model && follows && (
                        <button
                          aria-label="Follow Pi's default model"
                          className="shrink-0 rounded p-1 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                          onClick={() => setFamily(name, { model: undefined })}
                          title={`Follow Pi's default model (${follows})`}
                          type="button"
                        >
                          <XIcon className="size-3" />
                        </button>
                      )}
                    </div>
                    {(families[name].model ?? follows) && (!info || !info.available) && (
                      <p
                        className="mt-0.5 truncate font-sans text-[10.5px] text-warning"
                        title="Its members run the default model until it has a login"
                      >
                        {info ? `no ${info.provider} login` : 'not in the model list'}
                      </p>
                    )}
                  </td>
                )
              })}
            </SettingRow>
            <SettingRow cell={cell} label="Thinking">
              {names.map((name) => {
                const follows = view.families.find((family) => family.name === name)
                const info = find(families[name].model ?? follows?.follows)
                const levels = info?.reasoning ? info.thinkingLevels : info ? ['off'] : []
                // A built-in level can be changed but not cleared: settings keep only what differs from it.
                const inherit = !BUILTIN_FAMILIES[name]?.thinking
                const current = families[name].thinking
                return (
                  <td className={cell} key={name}>
                    <select
                      aria-label={`${name} thinking`}
                      className={selectClass}
                      onChange={(event) =>
                        setFamily(name, {
                          thinking:
                            event.target.value === ''
                              ? undefined
                              : (event.target.value as Draft['thinking']),
                        })
                      }
                      value={current ?? ''}
                    >
                      {inherit && (
                        <option value="">
                          {name === DEFAULT_FAMILY && follows?.followsThinking
                            ? `Pi · ${follows.followsThinking}`
                            : 'inherit'}
                        </option>
                      )}
                      {[...new Set([...levels, ...(current ? [current] : [])])].map((level) => (
                        <option key={level} value={level}>
                          {level}
                        </option>
                      ))}
                    </select>
                  </td>
                )
              })}
            </SettingRow>
            <tr>
              <td className={cn(cell, 'py-1')} colSpan={columns}>
                <button
                  aria-expanded={more}
                  className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => setMore(!more)}
                  type="button"
                >
                  <ChevronRightIcon
                    className={cn('size-3 transition-transform', more && 'rotate-90')}
                  />
                  More settings
                  {!more && (limits.global || Object.keys(limits.models).length > 0) && (
                    <span className="text-warning">· caps set</span>
                  )}
                </button>
              </td>
            </tr>
            {more && (
              <SettingRow
                cell={cell}
                hint={
                  <span className="flex items-center gap-1.5">
                    all models
                    <span className="w-16">
                      <LimitInput
                        label="Overall cap"
                        onChange={(global) => setLimits({ ...limits, global })}
                        value={limits.global}
                      />
                    </span>
                  </span>
                }
                label="At most, at once"
                title="Model requests over a cap wait for a free slot, first come first served. A cap holds the family's model, so families on the same model share it."
              >
                {names.map((name) => {
                  const model =
                    families[name].model ??
                    view.families.find((family) => family.name === name)?.follows
                  const shared = sharedWith(name)
                  return (
                    <td className={cell} key={name}>
                      {model ? (
                        <>
                          <LimitInput
                            label={`${model} cap`}
                            onChange={(value) => {
                              const { [model]: _old, ...rest } = limits.models
                              setLimits({
                                ...limits,
                                models: value ? { ...rest, [model]: value } : rest,
                              })
                            }}
                            value={limits.models[model]}
                          />
                          {shared.length > 0 && (
                            <p className="mt-0.5 truncate font-sans text-[10.5px] text-muted-foreground/70">
                              shared with {shared.map(familyTitle).join(', ')}
                            </p>
                          )}
                        </>
                      ) : null}
                    </td>
                  )
                })}
              </SettingRow>
            )}
            {groups.map(([group, list]) => (
              <Fragment key={group}>
                <tr>
                  <td className={cn(label, 'px-1.5 pt-4 pb-1')} colSpan={columns}>
                    {group}
                  </td>
                </tr>
                {list.map((user) => (
                  <UserRow
                    cell={cell}
                    changed={choice(user) !== choiceOf(user)}
                    choice={choice(user)}
                    colors={Object.fromEntries(names.map((name) => [name, families[name].color]))}
                    families={names}
                    key={user.id}
                    onMove={(to) => move(user.id, to)}
                    open={view.open[user.id] ?? 0}
                    user={user}
                  />
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <footer className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/70 px-5 py-3">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {changes ? (
            `${changes} change${changes === 1 ? '' : 's'}`
          ) : saved ? (
            <span className="text-success">{saved}</span>
          ) : (
            'Applies to this project; new projects start from the families you applied last'
          )}
        </span>
        {changes > 0 && affected > 0 && (
          <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <Checkbox
              checked={switchRunning}
              onCheckedChange={(value) => setSwitchRunning(value === true)}
            />
            also switch {affected} open conversation{affected === 1 ? '' : 's'}
          </label>
        )}
        {changes > 0 ? (
          <Button className="h-7 px-3 text-[12px]" onClick={discard} size="sm" variant="ghost">
            Discard
          </Button>
        ) : (
          <Button className="h-7 px-3 text-[12px]" onClick={close} size="sm" variant="ghost">
            Close
          </Button>
        )}
        <Button
          className="h-7 px-3 text-[12px]"
          disabled={!changes || pending}
          onClick={() => void apply()}
          size="sm"
        >
          {pending ? 'Applying…' : 'Apply'}
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

/** One family setting across every family: its label, then one cell per family. */
function SettingRow({
  label: name,
  hint,
  title,
  cell,
  children,
}: {
  label: string
  hint?: ReactNode
  title?: string
  cell: string
  children: ReactNode
}) {
  return (
    <tr>
      <td className={cn(cell, 'pr-3')} title={title}>
        <div className="font-mono text-[11.5px] text-foreground/85">{name}</div>
        {hint && <div className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">{hint}</div>}
      </td>
      {children}
      <td className={cell} />
    </tr>
  )
}

function FamilyHeader({
  name,
  color,
  project,
  onColor,
  onRemove,
}: {
  name: string
  color: string
  project?: true
  onColor: (color: string) => void
  onRemove?: () => void
}) {
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 border-t-2 pt-1.5"
      style={{ borderTopColor: familyColor(color) }}
    >
      <ColorPicker color={color} onChange={onColor} />
      <span
        className="truncate font-mono text-[12.5px] font-medium"
        style={{ color: familyColor(color) }}
      >
        {familyTitle(name)}
      </span>
      {project && <Tag title="The project's settings change this family">project</Tag>}
      {onRemove && (
        <button
          aria-label={`Remove ${name}`}
          className="ml-auto rounded p-0.5 text-muted-foreground/50 hover:bg-accent hover:text-error"
          onClick={onRemove}
          type="button"
        >
          <Trash2Icon className="size-3" />
        </button>
      )}
    </div>
  )
}

function UserRow({
  user,
  choice,
  families,
  colors,
  changed,
  open,
  cell,
  onMove,
}: {
  user: FamilyUser
  choice: string
  families: string[]
  colors: Record<string, string>
  changed: boolean
  open: number
  cell: string
  onMove: (to: string) => void
}) {
  const Icon = user.kind === 'agent' ? BotIcon : SparklesIcon
  const locked = !!user.project
  return (
    <tr className="group hover:bg-accent/20">
      <td
        className={cn(cell, 'pr-3')}
        title={[user.description, locked && "Set in the project's settings"]
          .filter(Boolean)
          .join('\n')}
      >
        <div className="flex min-w-0 items-center gap-1.5 font-mono text-[12px]">
          <Icon className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate text-foreground/90">{user.label}</span>
          {changed && (
            <span aria-label="changed" className="size-1.5 shrink-0 rounded-full bg-brand" />
          )}
          {user.source && user.source !== 'builtin' && <Tag>{user.source}</Tag>}
          {user.pinned && (
            // Kept, the pin shows its model and a family replaces it; replaced, a quiet icon brings it back.
            <button
              className={cn(
                'flex min-w-0 items-center gap-1 rounded font-mono text-[10px]',
                choice === PINNED
                  ? 'border border-foreground/40 px-1 text-foreground/80'
                  : 'p-0.5 text-muted-foreground/40 hover:text-foreground',
              )}
              disabled={locked}
              onClick={() => onMove(PINNED)}
              title={`${user.pinnedIn} pins ${user.pinned}${choice === PINNED ? '; pick a family to replace it' : '; a family replaces it, click to keep the pin'}`}
              type="button"
            >
              <PinIcon className="size-2.5 shrink-0" />
              {choice === PINNED && (
                <span className="truncate">{user.pinned.slice(user.pinned.indexOf('/') + 1)}</span>
              )}
            </button>
          )}
          {open > 0 && (
            <span
              className="ml-auto shrink-0 font-mono text-[10.5px] text-success"
              title={`${open} open conversation${open === 1 ? '' : 's'} on its family's model`}
            >
              ● {open}
            </span>
          )}
        </div>
        <p className="truncate pl-4.5 font-sans text-[11px] text-muted-foreground/70">
          {user.description}
        </p>
      </td>
      {families.map((name) => {
        const on = choice === name
        return (
          <td className={cn(cell, 'text-center')} key={name}>
            <button
              aria-label={`Run ${user.label} on ${name}`}
              aria-pressed={on}
              className={cn(
                'inline-block size-4 rounded-full border-[1.5px] border-border transition-transform',
                !locked && 'hover:scale-125 hover:border-muted-foreground',
                on && 'border-[5px]',
              )}
              disabled={locked}
              onClick={() => onMove(name)}
              style={on ? { borderColor: familyColor(colors[name]) } : undefined}
              type="button"
            />
          </td>
        )
      })}
      <td className={cell} />
    </tr>
  )
}

function AddFamily({ taken, onAdd }: { taken: string[]; onAdd: (name: string) => void }) {
  const [open, setOpen] = useState(false)
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
    setOpen(false)
  }
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-label="New family"
          className="flex size-6 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground hover:border-muted-foreground hover:text-foreground"
          title="New family"
          type="button"
        >
          <PlusIcon className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 space-y-2 p-2">
        <div className={label}>New family</div>
        <input
          aria-invalid={problem ? true : undefined}
          aria-label="New family name"
          autoFocus
          className={cn(selectClass, 'px-2')}
          onChange={(event) => setName(event.target.value.trim().toLowerCase())}
          onKeyDown={(event) => {
            if (event.key === 'Enter') add()
          }}
          placeholder="local"
          spellCheck={false}
          value={name}
        />
        {problem && <p className="font-sans text-[11px] text-error">{problem}</p>}
        <Button
          className="h-7 w-full text-[12px]"
          disabled={!name || !!problem}
          onClick={add}
          size="sm"
          variant="outline"
        >
          Add column
        </Button>
      </PopoverContent>
    </Popover>
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
      placeholder="∞"
      step={1}
      type="number"
      value={value ?? ''}
    />
  )
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
            <span className="min-w-0 truncate">{value.slice(slash + 1)}</span>
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
