import { CalendarClock, Check, Coins, LoaderCircle, Radar, X, Zap } from '@lucide/solid'
import { Dynamic } from '@solidjs/web'
import type { JSX } from '@solidjs/web'
import { createMemo, createSignal, createStore, For, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Checkbox } from '@/components/ui/checkbox.solid.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog.solid.tsx'
import { DropdownMenuRadioItem } from '@/components/ui/dropdown-menu.solid.tsx'
import { Form } from '@/components/ui/form.solid.tsx'
import { Input, Textarea } from '@/components/ui/input.solid.tsx'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control.solid.tsx'
import { Toggle } from '@/components/ui/toggle.solid.tsx'
import {
  api,
  cn,
  errorMessage,
  events,
  formatKeys,
  keepLast,
  PromptBox,
  ROOT,
  useAction,
  useConversationId,
  useEvent,
  writerNow,
  writingAs,
} from '@/sdk/solid'
import { contextCondition, draftOf, scheduleOf, triggerOf, zone } from './form-draft.web.ts'
import type { Draft, FilterType, Mode } from './form-draft.web.ts'
import { AgentPicker, Picker } from './picker.solid.tsx'
import { Preview } from './preview.solid.tsx'
import { CreateAction, EventsAction, UpdateAction } from './refs.ts'
import type { Automation } from './refs.ts'

const input = 'h-8 bg-transparent px-2.5 font-sans text-[13px]'
const monoInput = `${input} font-mono text-[12.5px]`
const label = 'text-[12.5px] font-medium text-foreground/90'
const area = 'bg-transparent px-2.5'
const submitKeys = (formatKeys('mod+enter')[0] ?? []).join('+')
const triggers = [
  {
    value: 'schedule',
    label: 'On a schedule',
    hint: 'run a prompt at set times',
    icon: CalendarClock,
  },
  {
    value: 'script',
    label: 'When something happens',
    hint: 'a script watches for it',
    icon: Radar,
  },
  { value: 'ultimate', label: 'When Ultimate…', hint: 'an event or context fill', icon: Zap },
] as const

function Field(props: { label: string; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-1.5">
      <span class={label}>{props.label}</span>
      {props.children}
    </div>
  )
}

type Change = (patch: Partial<Draft>) => void

export function AutomationForm(props: {
  open: boolean
  automation?: Automation
  close: () => void
  finalFocus: () => HTMLElement | null
  onSaved: () => void
}) {
  const [definition, setDefinition] = createSignal<{
    name: string
    source: string
    refresh: () => void
  }>()
  const [returning, setReturning] = createSignal(false)
  useEvent('subagents:definition-closed', () => {
    const suspended = definition()
    if (!suspended) return
    suspended.refresh()
    setReturning(true)
    setDefinition(undefined)
  })
  return (
    <Dialog
      open={props.open && !definition()}
      onOpenChange={(open, details) => {
        if (details.reason === 'outside-press') details.cancel()
        else if (!open && !definition()) props.close()
      }}
      onOpenChangeComplete={(open) => {
        const suspended = definition()
        if (!open && suspended)
          writingAs(suspended.source, () =>
            events.emit('subagents:open-definition', { name: suspended.name }),
          )
      }}
    >
      <DialogContent
        class="flex max-h-[min(48rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
        keepMounted={props.open}
        initialFocus={returning() ? '[data-automation-configure]' : '[data-automation-name]'}
        finalFocus={definition() ? 'none' : props.finalFocus}
      >
        <Editor
          automation={props.automation}
          close={props.close}
          onConfigure={(name, source, refresh) => setDefinition({ name, source, refresh })}
          onSaved={props.onSaved}
        />
      </DialogContent>
    </Dialog>
  )
}

function Editor(props: {
  automation?: Automation
  close: () => void
  onConfigure: (name: string, source: string, refresh: () => void) => void
  onSaved: () => void
}) {
  const [draft, setDraft] = createStore(() => draftOf(props.automation))
  const set: Change = (patch) =>
    setDraft((next) => {
      Object.assign(next, patch)
    })
  const [error, setError] = createSignal<string>()
  const conversation = useConversationId()
  const script = () => draft.trigger === 'script'
  const domain = () => draft.trigger === 'ultimate'
  const wakeable = () => script() || domain()
  const promptText = () => draft.prompt.trim()
  const [saving, setSaving] = createSignal(false)
  const [uploading, setUploading] = createSignal(false)
  const validTrigger = createMemo(() => triggerOf(draft))
  const automationName = () => draft.name.trim()
  const ready = () =>
    !!automationName() &&
    !!validTrigger() &&
    (!!promptText() ||
      (props.automation ? props.automation.subscribers.length > 0 : wakeable() && draft.wake))

  async function save(source: string) {
    const details = validTrigger()
    if (!ready() || !details || saving() || uploading()) return
    setSaving(true)
    setError(undefined)
    const automation = props.automation
    const text = promptText()
    const id = conversation()
    const fields = { name: automationName(), ...details, ...(text ? { prompt: text } : {}) }
    const { close, onSaved } = props
    try {
      if (automation)
        await api.action(UpdateAction, {
          id: automation.id,
          ...fields,
          ...(!text && automation.prompt ? { prompt: '' } : {}),
          ...(text ? { agent: draft.agent } : {}),
        })
      else
        await api.action(CreateAction, {
          ...fields,
          ...(text && draft.agent ? { agent: draft.agent } : {}),
          ...(wakeable() && text && draft.wake && id !== undefined ? { subscribers: [id] } : {}),
        })
      writingAs(source, () => {
        onSaved()
        close()
      })
    } catch (failure) {
      setError(errorMessage(failure).replace(/^automations\/\w+: /, ''))
    } finally {
      setSaving(false)
    }
  }
  return (
    <Form class="flex min-h-0 flex-1 flex-col">
      <div class="px-5 pt-5 pb-3">
        <DialogTitle class="text-[14px] font-medium">
          {props.automation ? 'Edit automation' : 'New automation'}
        </DialogTitle>
        <DialogDescription class="mt-1.5 text-[12.5px] leading-relaxed">
          {script()
            ? 'An agent writes a small script that watches for it, then wakes you or runs a prompt when it happens.'
            : domain()
              ? 'Wake a conversation or run a prompt when Ultimate emits an event or a context fills up.'
              : 'Runs the prompt on a schedule. Each run is a new conversation you can open.'}
        </DialogDescription>
      </div>
      <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pt-1 pb-5">
        <Show when={!props.automation}>
          <SegmentedControl
            aria-label="Trigger type"
            bind={[() => draft.trigger, (trigger) => set({ trigger })]}
            class="grid grid-cols-1 gap-1 bg-background sm:grid-cols-3"
          >
            <For each={triggers}>
              {(option) => (
                <SegmentedControlItem
                  aria-label={option.label}
                  class="h-auto justify-start gap-2 rounded-[5px] px-2.5 py-1.5 text-left font-sans"
                  value={option.value}
                >
                  <Dynamic component={option.icon} aria-hidden="true" class="size-3.5 shrink-0" />
                  <span class="flex min-w-0 flex-col">
                    <span class="text-[12.5px]">{option.label}</span>
                    <span class="truncate text-[11px] text-muted-foreground">{option.hint}</span>
                  </span>
                </SegmentedControlItem>
              )}
            </For>
          </SegmentedControl>
        </Show>
        <Field label="Name">
          <Input
            aria-label="Name"
            class={input}
            data-automation-name
            onValueChange={(name) => set({ name })}
            placeholder={script() ? 'CI of PR #812' : domain() ? 'Context care' : 'Morning summary'}
            value={draft.name}
          />
        </Field>
        <Show when={domain()}>
          <fieldset class="flex flex-col gap-3">
            <legend class={cn(label, 'mb-1.5')}>Ultimate condition</legend>
            <SegmentedControl
              aria-label="Condition type"
              bind={[() => draft.ultimate, (ultimate) => set({ ultimate })]}
              class="self-start"
            >
              <SegmentedControlItem
                disabled={!!props.automation && draft.ultimate !== 'event'}
                value="event"
              >
                Something happens
              </SegmentedControlItem>
              <SegmentedControlItem
                disabled={!!props.automation && draft.ultimate !== 'context'}
                value="context"
              >
                Context threshold
              </SegmentedControlItem>
            </SegmentedControl>
            <Show
              when={draft.ultimate === 'event'}
              fallback={<ContextFields draft={draft} set={set} />}
            >
              <EventFields draft={draft} set={set} />
            </Show>
          </fieldset>
        </Show>
        <Show when={script()}>
          <Field label="Watch for">
            <Textarea
              aria-label="Watch for"
              class={`${area} min-h-20`}
              onValueChange={(ask) => set({ ask })}
              placeholder="The CI of PR #812 finishes, green or red."
              rows={3}
              submitShortcut="mod+enter"
              value={draft.ask}
            />
          </Field>
          <label class="-mt-1.5 flex items-center gap-2 text-[12.5px] text-foreground/90">
            <Checkbox
              aria-label="Keep watching after it happens"
              bind={[() => !draft.once, (checked) => set({ once: !checked })]}
            />
            Keep watching after it happens
            <span class="text-[11.5px] text-muted-foreground">
              {draft.once ? 'stops after the first time' : 'fires every time'}
            </span>
          </label>
        </Show>
        <Show when={wakeable() && !props.automation}>
          <label class="flex items-center gap-2 text-[12.5px] text-foreground/90">
            <Checkbox
              aria-label="Wake this conversation"
              bind={[() => draft.wake, (wake) => set({ wake })]}
            />
            Wake this conversation
            <Show when={conversation() !== undefined}>
              <span class="font-mono text-[11px] text-muted-foreground">#{conversation()}</span>
            </Show>
          </label>
        </Show>
        <Field label={wakeable() ? 'Prompt (optional)' : 'Prompt'}>
          <PromptBox
            accepts={{ images: false }}
            draft={undefined}
            label={wakeable() ? 'Prompt (optional)' : 'Prompt'}
            minimal
            name="the automation's prompt"
            onSubmit={() => save(writerNow())}
            onUploading={setUploading}
            ready={ready}
            onValue={(prompt) => set({ prompt })}
            placeholder={
              wakeable()
                ? 'Optional: also run a prompt in a new conversation, e.g. Summarise the failing tests.'
                : 'Summarise yesterday’s commits and open questions.'
            }
            sendButton={false}
            value={draft.prompt}
          />
        </Field>
        <Show when={!wakeable()}>
          <ScheduleFields draft={draft} set={set} />
        </Show>
        <Show when={!wakeable() || !!promptText()}>
          <Field label="Agent">
            <AgentPicker
              value={draft.agent}
              onChange={(agent) => set({ agent })}
              onConfigure={props.onConfigure}
            />
          </Field>
        </Show>
        <Show when={error()}>
          <p
            role="alert"
            class="flex items-start gap-1.5 font-mono text-[11.5px] leading-snug break-words text-error"
          >
            <X class="mt-px size-3 shrink-0" />
            {error()}
          </p>
        </Show>
      </div>
      <footer class="flex items-center gap-2 border-t border-border/70 bg-sidebar px-5 py-3">
        <p class="flex min-w-0 items-start gap-1.5 text-[11.5px] leading-snug text-muted-foreground">
          <Coins class="mt-px size-3.5 shrink-0 text-warning" />
          {script()
            ? 'Writing and repairing the script costs tokens; watching does not. Each fire wakes the agent, which costs tokens.'
            : 'Each fire wakes the agent, which costs tokens.'}
        </p>
        <Button class="ml-auto" onClick={() => props.close()} size="sm" variant="ghost">
          Cancel
        </Button>
        <Button
          class="group/automation-save"
          disabled={!ready() || saving() || uploading()}
          onClick={(_, details) => save(details.source)}
          size="sm"
          title={`${props.automation ? 'Save' : 'Create'} (${submitKeys})`}
          type="submit"
        >
          <LoaderCircle
            aria-hidden="true"
            class="hidden size-3.5 group-data-pending/automation-save:block motion-safe:animate-spin"
          />
          {props.automation ? 'Save changes' : 'Create'}
        </Button>
      </footer>
    </Form>
  )
}

type FieldsProps = { draft: Draft; set: Change }
const presets = [
  { label: 'Weekdays at 9', patch: { mode: 'cron', cron: '0 9 * * 1-5' } },
  { label: 'Hourly', patch: { mode: 'every', every: '1h' } },
  { label: 'In 30 minutes', patch: { mode: 'at', at: 'in 30m' } },
] satisfies { label: string; patch: Partial<Draft> }[]
const modes = {
  cron: { label: 'Cron', hint: 'minute hour day month weekday · Sunday is 0' },
  at: { label: 'Once', hint: 'once: in 30m, in 2h, or a local date and time' },
  every: { label: 'Interval', hint: 'an interval: 30s, 15m, 2h, 1d · at least 1s' },
}
const modeKeys: Mode[] = ['cron', 'at', 'every']
const zones = [...new Set([zone, 'UTC', ...Intl.supportedValuesOf('timeZone')])]

function ScheduleFields(props: FieldsProps) {
  const draft = () => props.draft
  const mode = () => draft().mode
  return (
    <fieldset class="flex flex-col gap-2">
      <legend class={cn(label, 'mb-1.5')}>Schedule</legend>
      <div class="flex flex-wrap gap-1.5">
        <For each={presets}>
          {(preset) => (
            <Toggle
              pressed={Object.entries(preset.patch).every(
                ([key, value]) => draft()[key as keyof Draft] === value,
              )}
              class="group/preset h-6 gap-1 rounded-full border-border/80 px-2.5 text-[11.5px] font-normal text-muted-foreground data-pressed:border-brand/60 data-pressed:bg-brand/10 data-pressed:text-foreground"
              onPressedChange={(pressed, details) =>
                pressed ? props.set(preset.patch) : details.cancel()
              }
              size="xs"
              variant="outline"
            >
              <Check
                aria-hidden="true"
                class="hidden size-3 text-brand group-data-pressed/preset:block"
              />
              {preset.label}
            </Toggle>
          )}
        </For>
      </div>
      <div class="flex items-center gap-2">
        <SegmentedControl
          aria-label="Schedule kind"
          bind={[mode, (value) => props.set({ mode: value })]}
          class="bg-background"
        >
          <For each={modeKeys}>
            {(key) => (
              <SegmentedControlItem class="rounded-[5px] px-2.5" value={key}>
                {modes[key].label}
              </SegmentedControlItem>
            )}
          </For>
        </SegmentedControl>
        <span class="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground/70">
          {modes[mode()].hint}
        </span>
      </div>
      <Show
        when={mode() === 'cron'}
        fallback={
          <Show
            when={mode() === 'at'}
            fallback={
              <Input
                aria-label="Interval length"
                class={monoInput}
                onValueChange={(every) => props.set({ every })}
                placeholder="15m"
                value={draft().every}
              />
            }
          >
            <Input
              aria-label="Run time"
              class={monoInput}
              onValueChange={(at) => props.set({ at })}
              placeholder="in 30m · 2026-12-01 09:00"
              value={draft().at}
            />
          </Show>
        }
      >
        <div class="flex gap-2">
          <Input
            aria-label="Crontab expression"
            class={`${monoInput} flex-[3]`}
            onValueChange={(cron) => props.set({ cron })}
            placeholder="0 9 * * 1-5"
            value={draft().cron}
          />
          <Picker
            label="Timezone"
            class="flex-[2] font-mono text-[12.5px]"
            selection={<span class="truncate">{draft().tz}</span>}
            value={draft().tz}
            onChange={(tz) => props.set({ tz })}
          >
            <Show when={!zones.includes(draft().tz)}>
              <DropdownMenuRadioItem closeOnSelect value={draft().tz}>
                {draft().tz}
              </DropdownMenuRadioItem>
            </Show>
            <For each={zones}>
              {(tz) => (
                <DropdownMenuRadioItem closeOnSelect value={tz}>
                  {tz}
                </DropdownMenuRadioItem>
              )}
            </For>
          </Picker>
        </div>
      </Show>
      <Preview schedule={scheduleOf(draft())} />
    </fieldset>
  )
}

const filterTypes = { string: 'Text', number: 'Number', boolean: 'Boolean' }
function EventFields(props: FieldsProps) {
  const draft = () => props.draft
  const { data, error } = useAction(EventsAction, null, { conversation: ROOT, onError: keepLast })
  const selected = () => data()?.find((choice) => choice.name === draft().event)
  return (
    <>
      <Field label="Event">
        <Picker
          label="Choose domain event"
          value={draft().event}
          selection={
            <span class="truncate">
              {selected()?.description ?? (draft().event || 'Choose an event…')}
            </span>
          }
          onChange={(event) => props.set({ event, filters: {}, filterTypes: {} })}
        >
          <For each={data()} keyed={(event) => event.name}>
            {(event) => (
              <DropdownMenuRadioItem closeOnSelect value={event().name}>
                {event().description} · {event().name}
              </DropdownMenuRadioItem>
            )}
          </For>
        </Picker>
      </Field>
      <Show when={error()}>
        <p role="alert" class="text-[12px] text-error">
          Could not load events: {errorMessage(error())}
        </p>
      </Show>
      <For each={Object.keys(selected()?.fields ?? {})}>
        {(field) => {
          const type = () => draft().filterTypes[field] ?? 'string'
          return (
            <Field label={`${field} (optional filter)`}>
              <div class="flex gap-2">
                <Input
                  aria-label={`${field} filter value`}
                  class={input}
                  onValueChange={(value) =>
                    props.set({ filters: { ...draft().filters, [field]: value } })
                  }
                  placeholder={selected()?.fields[field]}
                  value={draft().filters[field] ?? ''}
                />
                <Picker
                  label={`${field} filter type`}
                  class="w-24 shrink-0"
                  value={type()}
                  selection={filterTypes[type()]}
                  onChange={(value) =>
                    props.set({
                      filterTypes: { ...draft().filterTypes, [field]: value as FilterType },
                      filters: { ...draft().filters, [field]: '' },
                    })
                  }
                >
                  <For each={Object.entries(filterTypes)}>
                    {([key, text]) => (
                      <DropdownMenuRadioItem closeOnSelect value={key}>
                        {text}
                      </DropdownMenuRadioItem>
                    )}
                  </For>
                </Picker>
              </div>
              <Show when={type() === 'boolean'}>
                <p class="text-[11px] text-muted-foreground">Enter true or false.</p>
              </Show>
            </Field>
          )
        }}
      </For>
    </>
  )
}

const contextNumbers = [
  { key: 'above', name: 'Context reaches (%)', min: 1, max: 99, step: 1 },
  { key: 'cooldownMinutes', name: 'Cooldown (minutes)', min: 0, step: 'any' },
  { key: 'idleHours', name: 'After a pause (hours without your input)', min: 0, step: 'any' },
] as const

function ContextFields(props: FieldsProps) {
  const condition = createMemo(() => contextCondition(props.draft))
  return (
    <>
      <Field label="Agent or conversation">
        <Input
          aria-label="Agent or conversation"
          class={input}
          onValueChange={(of) => props.set({ of })}
          placeholder="@ultimate or #123"
          value={props.draft.of}
        />
      </Field>
      <div class="grid grid-cols-2 gap-2">
        <For each={contextNumbers}>
          {(number) => (
            <div class={number.key === 'idleHours' ? 'col-span-2' : undefined}>
              <Field label={number.name}>
                <Input
                  aria-label={number.name}
                  class={input}
                  max={'max' in number ? number.max : undefined}
                  min={number.min}
                  onValueChange={(value) => props.set({ [number.key]: value })}
                  step={number.step}
                  type="number"
                  value={props.draft[number.key]}
                />
              </Field>
            </div>
          )}
        </For>
      </div>
      <p class="text-[11.5px] leading-relaxed text-muted-foreground">
        <Show
          when={condition()}
          fallback="Fill in each number: context 1–99%, cooldown and pause 0 or more."
        >
          {(value) => (
            <>
              {value().idleFor > 0 &&
                `Waits until you gave it no input for ${value().idleFor === 3600000 ? 'an hour' : `${value().idleFor / 3600000} hours`}. `}
              {value().above <= 10
                ? 'After firing, it cannot re-arm at a threshold of 10% or less.'
                : `Fires once, again after it drops below ${value().above - 10}% and ${value().cooldownMs === 3600000 ? 'an hour has' : `${value().cooldownMs / 60000} minutes have`} passed.`}
            </>
          )}
        </Show>
      </p>
    </>
  )
}
