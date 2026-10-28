import {
  BotIcon,
  CalendarClockIcon,
  CheckIcon,
  ChevronDownIcon,
  CoinsIcon,
  LoaderCircleIcon,
  RadarIcon,
  SlidersHorizontalIcon,
  XIcon,
  ZapIcon,
} from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Checkbox } from '@/components/ui/checkbox'
import {
  api,
  cn,
  errorMessage,
  events,
  formatKeys,
  useAction,
  useEvent,
  useNow,
  useUltimate,
} from '@/sdk'
import { clock, full, until, words } from './parts.tsx'
import { DefinitionsAction } from '../subagents/ui.tsx'
import { modelLabel, useFamilies } from '../models/ui.tsx'
import type { FamiliesView } from '../models/ui.tsx'
import { familyTitle } from '../../lib/families.ts'
import { CreateAction, DescribeAction, EventsAction, UpdateAction } from './refs.ts'
import type { Automation } from './refs.ts'

type Mode = 'cron' | 'at' | 'every'
interface Draft {
  trigger: 'schedule' | 'script' | 'ultimate'
  ultimate: 'event' | 'context'
  event: string
  filters: Record<string, string>
  filterTypes: Record<string, 'string' | 'number' | 'boolean'>
  of: string
  /** The number fields hold what was typed, so a cleared field stays empty instead of reading 0. */
  above: string
  cooldownMinutes: string
  /** Hours without the user's input before it may fire; 0 for none. */
  idleHours: string
  name: string
  prompt: string
  /** What a script watches for, in plain words; its watcher writes the script from it. */
  ask: string
  once: boolean
  /** Whether a fire wakes the conversation the form was opened beside. */
  wake: boolean
  mode: Mode
  cron: string
  tz: string
  /** `in 30m`, a local `2026-12-01 09:00`, or an ISO time with an offset. */
  at: string
  every: string
  /** An agent definition's name; empty for a copy of the main agent. */
  agent: string
}
type Model = { model?: { provider: string; modelId: string }; thinking?: string }
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
const zones = Intl.supportedValuesOf('timeZone')
const pad = (value: number) => String(value).padStart(2, '0')

const presets: { label: string; draft: Partial<Draft> }[] = [
  { label: 'Every weekday at 9', draft: { mode: 'cron', cron: '0 9 * * 1-5' } },
  { label: 'Every hour', draft: { mode: 'every', every: '1h' } },
  { label: 'In 30 minutes', draft: { mode: 'at', at: 'in 30m' } },
]
const triggers = [
  {
    value: 'schedule',
    label: 'On a schedule',
    hint: 'run a prompt at set times',
    icon: CalendarClockIcon,
  },
  {
    value: 'script',
    label: 'When something happens',
    hint: 'a script watches for it',
    icon: RadarIcon,
  },
  { value: 'ultimate', label: 'When Ultimate…', hint: 'an event or context fill', icon: ZapIcon },
] as const
const modes: { value: Mode; label: string; hint: string }[] = [
  { value: 'cron', label: 'Cron', hint: 'minute hour day month weekday · Sunday is 0' },
  { value: 'at', label: 'At', hint: 'once: in 30m, in 2h, or a local date and time' },
  { value: 'every', label: 'Every', hint: 'an interval: 30s, 15m, 2h, 1d · at least 1s' },
]

function draftOf(automation?: Automation): Draft {
  const blank: Draft = {
    trigger: 'schedule',
    ultimate: 'context',
    event: '',
    filters: {},
    filterTypes: {},
    of: '@ultimate',
    above: '80',
    cooldownMinutes: '60',
    idleHours: '0',
    name: '',
    prompt: '',
    ask: '',
    once: true,
    wake: true,
    mode: 'cron',
    cron: '0 9 * * 1-5',
    tz: zone,
    at: 'in 30m',
    every: '1h',
    agent: '',
  }
  if (automation?.event || automation?.condition)
    return {
      ...blank,
      trigger: 'ultimate',
      ultimate: automation.event ? 'event' : 'context',
      name: automation.name,
      prompt: automation.prompt ?? '',
      agent: automation.agent ?? '',
      event: automation.event?.name ?? '',
      filters: Object.fromEntries(
        Object.entries(automation.event?.where ?? {}).map(([key, value]) => [key, String(value)]),
      ),
      filterTypes: Object.fromEntries(
        Object.entries(automation.event?.where ?? {}).map(([key, value]) => [
          key,
          typeof value as 'string' | 'number' | 'boolean',
        ]),
      ),
      of: automation.condition?.of ?? '@ultimate',
      above: String(automation.condition?.above ?? 80),
      cooldownMinutes: String((automation.condition?.cooldownMs ?? 3600000) / 60000),
      idleHours: String((automation.condition?.idleFor ?? 0) / 3600000),
    }
  if (automation?.script)
    return {
      ...blank,
      trigger: 'script',
      name: automation.name,
      prompt: automation.prompt ?? '',
      ask: automation.script.ask,
      once: automation.script.once,
      wake: automation.subscribers.length > 0,
      agent: automation.agent ?? '',
    }
  if (!automation?.schedule) return blank
  const { schedule } = automation
  const draft = {
    ...blank,
    name: automation.name,
    prompt: automation.prompt ?? '',
    mode: schedule.kind,
  }
  draft.agent = automation.agent ?? ''
  if (schedule.kind === 'cron') return { ...draft, cron: schedule.expr, tz: schedule.tz }
  if (schedule.kind === 'every') return { ...draft, every: interval(schedule.ms) }
  const date = new Date(schedule.time)
  const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  return { ...draft, at: date.getSeconds() ? `${local}:${pad(date.getSeconds())}` : local }
}

function interval(ms: number) {
  for (const [unit, size] of [
    ['d', 86400000],
    ['h', 3600000],
    ['m', 60000],
  ] as const)
    if (ms % size === 0) return `${ms / size}${unit}`
  return `${ms / 1000}s`
}

/** The schedule in the tool's grammar, which the actions accept; undefined while a field is empty. */
function scheduleOf(draft: Draft): string | undefined {
  if (draft.mode === 'cron')
    return draft.cron.trim() ? `cron "${draft.cron.trim()}" ${draft.tz.trim() || zone}` : undefined
  if (draft.mode === 'every') return draft.every.trim() ? `every ${draft.every.trim()}` : undefined
  const at = draft.at.trim()
  if (!at) return undefined
  if (/^in\s/.test(at)) return at.replace(/^in\s+/, 'in ')
  // A date and time without an offset is local to this browser, which runs on the machine Ultimate runs on.
  const local = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d)?$/.test(at) && new Date(at.replace(' ', 'T'))
  return `at ${local && Number.isFinite(local.getTime()) ? local.toISOString() : at}`
}

/** An empty field is no number: `Number('')` would read it as 0. */
const amount = (text: string) => (text.trim() === '' ? Number.NaN : Number(text))

/** The context condition the draft describes, or undefined while a field is empty or out of range. */
export function contextCondition(
  draft: Pick<Draft, 'of' | 'above' | 'cooldownMinutes' | 'idleHours'>,
) {
  const above = amount(draft.above)
  const cooldownMinutes = amount(draft.cooldownMinutes)
  const idleHours = amount(draft.idleHours)
  if (
    !/^(@[a-zA-Z0-9_-]+|#[1-9]\d*)$/.test(draft.of) ||
    !Number.isInteger(above) ||
    above < 1 ||
    above > 99 ||
    !Number.isFinite(cooldownMinutes) ||
    cooldownMinutes < 0 ||
    !Number.isFinite(idleHours) ||
    idleHours < 0
  )
    return undefined
  return {
    metric: 'context' as const,
    of: draft.of,
    above,
    cooldownMs: cooldownMinutes * 60000,
    idleFor: idleHours * 3600000,
  }
}

const matches = (draft: Draft, preset: Partial<Draft>) =>
  Object.entries(preset).every(([key, value]) => draft[key as keyof Draft] === value)

/** Waits `ms` after the last change of `value`. */
function useSettled<T>(value: T, ms: number) {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

const input =
  'h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 text-[13px] outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40'

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[12.5px] font-medium text-foreground/90" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  )
}

/** What the backend makes of the schedule: in words, the next fire times, and how often it costs a run. */
function Preview({ schedule }: { schedule: string | undefined }) {
  const settled = useSettled(schedule, 250)
  const described = useAction(
    DescribeAction,
    { schedule: settled ?? '' },
    { enabled: settled !== undefined, onError: () => {} },
  )
  const now = useNow(1000)
  const data = settled === schedule ? described.data : undefined
  const error = settled === schedule ? described.error : undefined
  const perDay =
    data && data.next.length > 1 ? Math.round(86400000 / (data.next[1] - data.next[0])) : 0
  return (
    <div className="min-h-[5.25rem] rounded-md border border-border/70 bg-card/60 px-2.5 py-2">
      {/* Announces what the schedule means, not the ticking countdown below. */}
      <span aria-live="polite" className="sr-only">
        {error ? error.message : data ? words(data.schedule, data.description, now) : ''}
      </span>
      {error ? (
        <p className="flex items-start gap-1.5 font-mono text-[11.5px] leading-snug text-error">
          <XIcon className="mt-px size-3 shrink-0" />
          {error.message.replace(/^automations\/describe: /, '')}
        </p>
      ) : !data ? (
        <p className="flex items-center gap-1.5 font-mono text-[11.5px] text-muted-foreground">
          {schedule === undefined ? (
            'Fill in the schedule to see its next runs.'
          ) : (
            <>
              <LoaderCircleIcon className="size-3 animate-spin" /> reading the schedule…
            </>
          )}
        </p>
      ) : (
        <>
          <p className="text-[12.5px] text-foreground/90">
            {words(data.schedule, data.description, now)}
          </p>
          <ol className="mt-1 flex flex-col gap-0.5 font-mono text-[11.5px]">
            {data.next.map((at, index) => (
              <li className="flex gap-2" key={at} title={full(at)}>
                <span className="w-9 shrink-0 text-muted-foreground/60">
                  {index === 0 ? 'next' : 'then'}
                </span>
                <span className="text-foreground/85 tabular-nums">{clock(at, now)}</span>
                {index === 0 && (
                  <span className={at <= now ? 'text-warning' : 'text-muted-foreground'}>
                    {at <= now ? 'passed: fires at once' : until(at, now)}
                  </span>
                )}
              </li>
            ))}
          </ol>
          {perDay > 1 && (
            <p className="mt-1 font-mono text-[11px] text-warning">
              about {perDay.toLocaleString()} runs a day
            </p>
          )}
        </>
      )}
    </div>
  )
}

/** "Fast (gpt-6-luna) · low": a definition by its family, a pin or the main agent by its model. */
const model = (
  families: FamiliesView | undefined,
  agent:
    | (Model & { runs?: { family?: string; model?: Model['model']; thinking?: string } })
    | undefined,
  fallback: string,
) => {
  const thinking = agent?.runs ? agent.runs.thinking : agent?.thinking
  const level = thinking ? ` · ${thinking}` : ''
  if (agent?.runs?.family) {
    const family = families?.families.find((item) => item.name === agent.runs?.family)
    const id = family?.model?.slice(family.model.indexOf('/') + 1)
    return `${familyTitle(agent.runs.family)}${id ? ` (${id})` : ''}${level}`
  }
  return agent?.model ? `${modelLabel(families, agent.model, thinking)}${level}` : fallback
}

/** Which agent runs the prompt: a copy of the main agent, or a shared agent definition with its own model. */
function AgentPicker({ value, onChange }: { value: string; onChange: (agent: string) => void }) {
  const { data, refetch } = useAction(DefinitionsAction, null, {
    onError: () => {},
  })
  // A definition changed in its config dialog shows its new model here once the dialog closes, and focus comes back to
  // Configure: opened over the bus, that dialog has no trigger of its own to return focus to.
  const configure = useRef<HTMLButtonElement>(null)
  const opened = useRef(false)
  useEvent('subagents:definition-closed', () => {
    if (!opened.current) return
    opened.current = false
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    void refetch()
    requestAnimationFrame(() => configure.current?.focus())
  })
  const definitions = data?.definitions ?? []
  const chosen = definitions.find((definition) => definition.name === value)
  const families = useFamilies()
  const main = model(families, data?.main, "the main conversation's model")
  const inherits = `inherits · ${data?.main?.model ? modelLabel(families, data.main.model) : 'main'}`
  return (
    <div className="flex gap-2">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-label="Agent"
            className={cn(input, 'flex items-center gap-2 text-left')}
            id="automation-agent"
            type="button"
          >
            <BotIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0 text-foreground/90">{value || 'Main agent'}</span>
            <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
              {value
                ? chosen
                  ? model(families, chosen, inherits)
                  : 'not found'
                : `a copy of main · ${main}`}
            </span>
            <ChevronDownIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-72 w-(--radix-dropdown-menu-trigger-width) min-w-72"
        >
          <DropdownMenuRadioGroup onValueChange={onChange} value={value}>
            <DropdownMenuRadioItem className="items-start text-[12.5px]" value="">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-baseline gap-2">
                  <span>Main agent</span>
                  <span className="ml-auto truncate font-mono text-[10.5px] text-muted-foreground">
                    {main}
                  </span>
                </span>
                <span className="text-[11.5px] text-muted-foreground">
                  A copy of the main conversation's agent, its tools and model
                </span>
              </span>
            </DropdownMenuRadioItem>
            {definitions.map((definition) => (
              <DropdownMenuRadioItem
                className="items-start text-[12.5px]"
                key={definition.name}
                value={definition.name}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-baseline gap-2">
                    <span className="font-mono">{definition.name}</span>
                    <span className="ml-auto truncate font-mono text-[10.5px] text-muted-foreground">
                      {model(families, definition, inherits)}
                    </span>
                  </span>
                  <span className="line-clamp-2 text-[11.5px] text-muted-foreground">
                    {definition.description}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            ))}
            {value && !chosen && data && (
              <DropdownMenuRadioItem className="text-[12.5px] text-error" value={value}>
                {value} (not found)
              </DropdownMenuRadioItem>
            )}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {chosen && (
        <Button
          className="h-8 shrink-0 gap-1.5 px-2.5 text-[12px]"
          onClick={() => {
            opened.current = true
            events.emit('subagents:open-definition', { name: chosen.name })
          }}
          ref={configure}
          size="sm"
          title={`Open the ${chosen.name} definition: model, thinking, tools, and instructions`}
          type="button"
          variant="outline"
        >
          <SlidersHorizontalIcon className="size-3.5" />
          Configure
        </Button>
      )}
    </div>
  )
}

/**
 * Create or edit an automation: name, prompt, schedule (presets or the raw forms) with the backend's preview, and the
 * agent. `automation` edits it; without one the form creates. `onClosed` runs once the dialog has gone, to move focus.
 * Mount it with a new `key` for each opening, so it starts from the automation as it is then, or blank.
 */
export function AutomationForm({
  open,
  automation,
  onOpenChange,
  onSaved,
  onClosed,
}: {
  open: boolean
  automation?: Automation
  onOpenChange: (open: boolean) => void
  onSaved: (automation: Automation) => void
  onClosed: () => void
}) {
  const [draft, setDraft] = useState(() => draftOf(automation))
  const [saving, setSaving] = useState(false)
  const eventChoices = useAction(EventsAction, null, { enabled: open, onError: () => {} })
  const [error, setError] = useState<string>()
  const ids = useId()
  const name = useRef<HTMLInputElement>(null)
  const set = (change: Partial<Draft>) => setDraft((previous) => ({ ...previous, ...change }))
  // A fire wakes the conversation the form opens beside: the shown one, which actions run on behalf of.
  const { conversationId } = useUltimate()
  const script = draft.trigger === 'script'
  const ultimate = draft.trigger === 'ultimate'
  const wakeable = script || ultimate
  const schedule = scheduleOf(draft)
  const condition = contextCondition(draft)
  const prompt = draft.prompt.trim()
  // A fire needs something to do: wake a conversation, run a prompt, or both. An edit keeps its subscribers.
  const acts = !!prompt || (automation ? automation.subscribers.length > 0 : wakeable && draft.wake)
  const validTrigger = script
    ? !!draft.ask.trim()
    : ultimate
      ? draft.ultimate === 'event'
        ? !!draft.event &&
          Object.entries(draft.filters).every(
            ([key, value]) =>
              !value ||
              (draft.filterTypes[key] === 'boolean'
                ? value === 'true' || value === 'false'
                : draft.filterTypes[key] !== 'number' || Number.isFinite(Number(value))),
          )
        : condition !== undefined
      : schedule !== undefined
  const ready = draft.name.trim() && validTrigger && acts && !saving
  const save = async () => {
    if (!ready) return
    setSaving(true)
    setError(undefined)
    try {
      const where = Object.fromEntries(
        Object.entries(draft.filters)
          .filter(([, value]) => value !== '')
          .map(([key, value]) => [
            key,
            draft.filterTypes[key] === 'number'
              ? Number(value)
              : draft.filterTypes[key] === 'boolean'
                ? value === 'true'
                : value,
          ]),
      )
      const trigger = script
        ? { ask: draft.ask.trim(), once: draft.once }
        : ultimate
          ? draft.ultimate === 'event'
            ? { event: { name: draft.event, where } }
            : { condition: condition! }
          : { schedule }
      const fields = { name: draft.name.trim(), ...trigger, ...(prompt ? { prompt } : {}) }
      const saved = automation
        ? await api.action(UpdateAction, {
            id: automation.id,
            ...fields,
            // An empty prompt removes the run action the automation had.
            ...(!prompt && automation.prompt ? { prompt: '' } : {}),
            ...(prompt ? { agent: draft.agent } : {}),
          })
        : await api.action(CreateAction, {
            ...fields,
            ...(prompt && draft.agent ? { agent: draft.agent } : {}),
            // Without a prompt the server subscribes the caller by itself; with one only when asked.
            ...(wakeable && prompt && draft.wake && conversationId !== undefined
              ? { subscribers: [conversationId] }
              : {}),
          })
      onSaved(saved)
      onOpenChange(false)
    } catch (failure) {
      setError(errorMessage(failure).replace(/^automations\/\w+: /, ''))
    } finally {
      setSaving(false)
    }
  }
  const submitOnModEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    // oxlint-disable-next-line typescript/no-floating-promises -- save catches failures and displays them with setError.
    void save()
  }
  const mode = modes.find((candidate) => candidate.value === draft.mode)!
  const submitKeys = formatKeys('mod+enter')[0] ?? []
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="flex max-h-[min(48rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onClosed()
        }}
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          name.current?.focus()
        }}
      >
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            // oxlint-disable-next-line typescript/no-floating-promises -- save catches failures and displays them with setError.
            void save()
          }}
        >
          <div className="px-5 pt-5 pb-3">
            <DialogTitle className="text-[14px] font-medium">
              {automation ? 'Edit automation' : 'New automation'}
            </DialogTitle>
            <DialogDescription className="mt-1.5 text-[12.5px] leading-relaxed">
              {script
                ? 'An agent writes a small script that watches for it, then wakes you or runs a prompt when it happens.'
                : ultimate
                  ? 'Wake a conversation or run a prompt when Ultimate emits an event or a context fills up.'
                  : 'Runs the prompt on a schedule. Each run is a new conversation you can open.'}
            </DialogDescription>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pt-1 pb-5">
            {!automation && (
              <div
                aria-label="Trigger"
                className="grid grid-cols-1 gap-1 rounded-md border border-border/80 bg-background p-0.5 sm:grid-cols-3"
                role="radiogroup"
              >
                {triggers.map((option) => (
                  <button
                    aria-checked={option.value === draft.trigger}
                    className={cn(
                      'flex items-center gap-2 rounded-[5px] px-2.5 py-1.5 text-left text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
                      option.value === draft.trigger && 'bg-accent text-foreground shadow-xs',
                    )}
                    key={option.value}
                    onClick={() => set({ trigger: option.value })}
                    role="radio"
                    type="button"
                  >
                    <option.icon className="size-3.5 shrink-0" />
                    <span className="flex min-w-0 flex-col">
                      <span className="text-[12.5px]">{option.label}</span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {option.hint}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <Field htmlFor={`${ids}-name`} label="Name">
              <input
                autoComplete="off"
                className={input}
                id={`${ids}-name`}
                onChange={(event) => set({ name: event.target.value })}
                placeholder={
                  script ? 'CI of PR #812' : ultimate ? 'Context care' : 'Morning summary'
                }
                ref={name}
                value={draft.name}
              />
            </Field>
            {ultimate && (
              <fieldset className="flex flex-col gap-3">
                <legend className="mb-1.5 text-[12.5px] font-medium">When Ultimate…</legend>
                <div className="flex gap-2" role="group" aria-label="Ultimate trigger">
                  {(['event', 'context'] as const).map((kind) => (
                    <Button
                      aria-pressed={draft.ultimate === kind}
                      disabled={!!automation && draft.ultimate !== kind}
                      key={kind}
                      onClick={() => set({ ultimate: kind })}
                      size="sm"
                      type="button"
                      variant={draft.ultimate === kind ? 'secondary' : 'outline'}
                    >
                      {kind === 'event' ? 'Something happens' : 'Context reaches'}
                    </Button>
                  ))}
                </div>
                {draft.ultimate === 'event' ? (
                  <>
                    <Field htmlFor={`${ids}-event`} label="Event">
                      <select
                        className={input}
                        id={`${ids}-event`}
                        onChange={(event) =>
                          set({ event: event.target.value, filters: {}, filterTypes: {} })
                        }
                        value={draft.event}
                      >
                        <option value="">Choose an event…</option>
                        {eventChoices.data?.map((event) => (
                          <option key={event.name} value={event.name}>
                            {event.description} · {event.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {eventChoices.error && (
                      <p role="alert" className="text-[12px] text-error">
                        Could not load events: {errorMessage(eventChoices.error)}
                      </p>
                    )}
                    {Object.entries(
                      eventChoices.data?.find((event) => event.name === draft.event)?.fields ?? {},
                    ).map(([field, description]) => (
                      <Field
                        htmlFor={`${ids}-filter-${field}`}
                        key={field}
                        label={`${field} (optional filter)`}
                      >
                        <div className="flex gap-2">
                          <input
                            className={input}
                            id={`${ids}-filter-${field}`}
                            onChange={(event) =>
                              set({ filters: { ...draft.filters, [field]: event.target.value } })
                            }
                            placeholder={description}
                            value={draft.filters[field] ?? ''}
                          />
                          <select
                            aria-label={`${field} value type`}
                            className={cn(input, 'w-24 shrink-0')}
                            onChange={(event) =>
                              set({
                                filterTypes: {
                                  ...draft.filterTypes,
                                  [field]: event.target.value as 'string' | 'number' | 'boolean',
                                },
                                filters: { ...draft.filters, [field]: '' },
                              })
                            }
                            value={draft.filterTypes[field] ?? 'string'}
                          >
                            <option value="string">Text</option>
                            <option value="number">Number</option>
                            <option value="boolean">Boolean</option>
                          </select>
                        </div>
                        {draft.filterTypes[field] === 'boolean' && (
                          <p className="text-[11px] text-muted-foreground">Enter true or false.</p>
                        )}
                      </Field>
                    ))}
                  </>
                ) : (
                  <>
                    <Field htmlFor={`${ids}-of`} label="Agent or conversation">
                      <input
                        className={input}
                        id={`${ids}-of`}
                        onChange={(event) => set({ of: event.target.value })}
                        placeholder="@ultimate or #123"
                        value={draft.of}
                      />
                    </Field>
                    <div className="grid grid-cols-2 gap-2">
                      <Field htmlFor={`${ids}-above`} label="Context reaches (%)">
                        <input
                          className={input}
                          id={`${ids}-above`}
                          max={99}
                          min={1}
                          onChange={(event) => set({ above: event.target.value })}
                          type="number"
                          value={draft.above}
                        />
                      </Field>
                      <Field htmlFor={`${ids}-cooldown`} label="Cooldown (minutes)">
                        <input
                          className={input}
                          id={`${ids}-cooldown`}
                          min={0}
                          step="any"
                          onChange={(event) => set({ cooldownMinutes: event.target.value })}
                          type="number"
                          value={draft.cooldownMinutes}
                        />
                      </Field>
                    </div>
                    <Field htmlFor={`${ids}-idle`} label="After a pause (hours without your input)">
                      <input
                        className={input}
                        id={`${ids}-idle`}
                        min={0}
                        step="any"
                        onChange={(event) => set({ idleHours: event.target.value })}
                        placeholder="0: no pause needed"
                        type="number"
                        value={draft.idleHours}
                      />
                    </Field>
                    <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                      {condition ? (
                        <>
                          {condition.idleFor > 0 &&
                            `Waits until you gave it no input for ${condition.idleFor === 3600000 ? 'an hour' : `${condition.idleFor / 3600000} hours`}. `}
                          Fires once, again after it drops below {condition.above - 10}% and{' '}
                          {condition.cooldownMs === 3600000
                            ? 'an hour has'
                            : `${condition.cooldownMs / 60000} minutes have`}{' '}
                          passed.
                        </>
                      ) : (
                        'Fill in each number: context 1–99%, cooldown and pause 0 or more.'
                      )}
                    </p>
                  </>
                )}
              </fieldset>
            )}
            {wakeable ? (
              <>
                {script && (
                  <>
                    <Field htmlFor={`${ids}-ask`} label="Watch for">
                      <textarea
                        className={cn(input, 'h-auto min-h-20 resize-y py-2 leading-relaxed')}
                        id={`${ids}-ask`}
                        onChange={(event) => set({ ask: event.target.value })}
                        onKeyDown={submitOnModEnter}
                        placeholder="The CI of PR #812 finishes, green or red."
                        rows={3}
                        value={draft.ask}
                      />
                    </Field>
                    <label className="-mt-1.5 flex items-center gap-2 text-[12.5px] text-foreground/90">
                      <Checkbox
                        checked={!draft.once}
                        onCheckedChange={(checked) => set({ once: checked !== true })}
                      />
                      Keep watching after it happens
                      <span className="text-[11.5px] text-muted-foreground">
                        {draft.once ? 'stops after the first time' : 'fires every time'}
                      </span>
                    </label>
                  </>
                )}
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1.5 text-[12.5px] font-medium text-foreground/90">
                    When it happens
                  </legend>
                  {!automation && (
                    <label className="flex items-center gap-2 text-[12.5px] text-foreground/90">
                      <Checkbox
                        checked={draft.wake}
                        onCheckedChange={(checked) => set({ wake: checked === true })}
                      />
                      Wake this conversation
                      {conversationId !== undefined && (
                        <span className="font-mono text-[11px] text-muted-foreground">
                          #{conversationId}
                        </span>
                      )}
                    </label>
                  )}
                  <textarea
                    aria-label="Prompt (optional)"
                    className={cn(input, 'h-auto min-h-16 resize-y py-2 leading-relaxed')}
                    onChange={(event) => set({ prompt: event.target.value })}
                    onKeyDown={submitOnModEnter}
                    placeholder="Optional: also run a prompt in a new conversation, e.g. Summarise the failing tests."
                    rows={2}
                    value={draft.prompt}
                  />
                </fieldset>
                {prompt && (
                  <Field htmlFor="automation-agent" label="Agent">
                    <AgentPicker onChange={(agent) => set({ agent })} value={draft.agent} />
                  </Field>
                )}
              </>
            ) : (
              <>
                <Field htmlFor={`${ids}-prompt`} label="Prompt">
                  <textarea
                    className={cn(input, 'h-auto min-h-24 resize-y py-2 leading-relaxed')}
                    id={`${ids}-prompt`}
                    onChange={(event) => set({ prompt: event.target.value })}
                    onKeyDown={submitOnModEnter}
                    placeholder="Summarise yesterday's commits and open questions."
                    rows={4}
                    value={draft.prompt}
                  />
                </Field>
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1.5 text-[12.5px] font-medium text-foreground/90">
                    Schedule
                  </legend>
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Presets">
                    {presets.map((preset) => {
                      const pressed = matches(draft, preset.draft)
                      return (
                        <button
                          aria-pressed={pressed}
                          className={cn(
                            'flex h-6 items-center gap-1 rounded-full border px-2.5 text-[11.5px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            pressed
                              ? 'border-brand/60 bg-brand/10 text-foreground'
                              : 'border-border/80 text-muted-foreground hover:border-border hover:text-foreground',
                          )}
                          key={preset.label}
                          onClick={() => set(preset.draft)}
                          type="button"
                        >
                          {pressed && <CheckIcon className="size-3 text-brand" />}
                          {preset.label}
                        </button>
                      )
                    })}
                  </div>
                  <div className="flex items-center gap-2">
                    <div
                      aria-label="Schedule kind"
                      className="inline-flex shrink-0 rounded-md border border-border/80 bg-background p-0.5 font-mono text-[11px]"
                      role="radiogroup"
                    >
                      {modes.map((option) => (
                        <button
                          aria-checked={option.value === draft.mode}
                          className={cn(
                            'flex h-6 items-center rounded-[5px] px-2.5 text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
                            option.value === draft.mode && 'bg-accent text-foreground shadow-xs',
                          )}
                          key={option.value}
                          onClick={() => set({ mode: option.value })}
                          role="radio"
                          type="button"
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                    <span className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground/70">
                      {mode.hint}
                    </span>
                  </div>
                  {draft.mode === 'cron' ? (
                    <div className="flex gap-2">
                      <input
                        aria-label="Cron expression"
                        autoComplete="off"
                        className={cn(input, 'flex-[3] font-mono text-[12.5px]')}
                        onChange={(event) => set({ cron: event.target.value })}
                        placeholder="0 9 * * 1-5"
                        spellCheck={false}
                        value={draft.cron}
                      />
                      <input
                        aria-label="Timezone"
                        autoComplete="off"
                        className={cn(input, 'flex-[2] font-mono text-[12.5px]')}
                        list={`${ids}-zones`}
                        onChange={(event) => set({ tz: event.target.value })}
                        placeholder={zone}
                        spellCheck={false}
                        value={draft.tz}
                      />
                      <datalist id={`${ids}-zones`}>
                        {zones.map((tz) => (
                          <option key={tz} value={tz} />
                        ))}
                      </datalist>
                    </div>
                  ) : draft.mode === 'at' ? (
                    <input
                      aria-label="Time"
                      autoComplete="off"
                      className={cn(input, 'font-mono text-[12.5px]')}
                      onChange={(event) => set({ at: event.target.value })}
                      placeholder="in 30m · 2026-12-01 09:00"
                      spellCheck={false}
                      value={draft.at}
                    />
                  ) : (
                    <input
                      aria-label="Interval"
                      autoComplete="off"
                      className={cn(input, 'font-mono text-[12.5px]')}
                      onChange={(event) => set({ every: event.target.value })}
                      placeholder="15m"
                      spellCheck={false}
                      value={draft.every}
                    />
                  )}
                  <Preview schedule={schedule} />
                </fieldset>
                <Field htmlFor="automation-agent" label="Agent">
                  <AgentPicker onChange={(agent) => set({ agent })} value={draft.agent} />
                </Field>
              </>
            )}
            {error && (
              <p className="flex items-start gap-1.5 font-mono text-[11.5px] leading-snug break-words text-error">
                <XIcon className="mt-px size-3 shrink-0" />
                {error}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 border-t border-border/70 bg-sidebar px-5 py-3">
            <p className="flex min-w-0 items-start gap-1.5 text-[11.5px] leading-snug text-muted-foreground">
              <CoinsIcon className="mt-px size-3.5 shrink-0 text-warning" />
              {script
                ? 'Writing and repairing the script costs tokens; watching does not. Each fire wakes the agent, which costs tokens.'
                : 'Each fire wakes the agent, which costs tokens.'}
            </p>
            <Button
              className="ml-auto"
              onClick={() => onOpenChange(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={!ready}
              size="sm"
              title={`${automation ? 'Save' : 'Create'} (${submitKeys.join('+')})`}
              type="submit"
            >
              {saving && <LoaderCircleIcon className="size-3.5 animate-spin" />}
              {automation ? 'Save' : 'Create'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
