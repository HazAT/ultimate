/** @jsxImportSource @solidjs/web */
import { ChevronDown, Plus } from '@lucide/solid'
import { createMemo, createSignal, For, Show, untrack } from 'solid-js'
import type { JSX } from '@solidjs/web'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.solid.tsx'
import { Form } from '@/components/ui/form.solid.tsx'
import { Input } from '@/components/ui/input.solid.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.solid.tsx'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control.solid.tsx'
import { api, errorMessage, useModels } from '@/sdk/solid'
import {
  BUILTIN_FAMILIES,
  DEFAULT_FAMILY,
  FAMILY_COLORS,
  FEATURES,
  familyColor,
  familyTitle,
  isFamilyName,
} from '../../lib/families.ts'
import { refreshFamilies } from './families.solid.tsx'
import { modelIdOf } from './family-state.ts'
import { ModelSelect } from './model-select.solid.tsx'
import { SaveFamiliesAction } from './refs.ts'
import type { FamiliesView, FamilyView, SaveFamilies } from './refs.ts'

const colors = Object.keys(FAMILY_COLORS)
const control =
  'h-7 w-full min-w-0 rounded-md border border-border/80 bg-background px-2 font-mono text-[11.5px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40'

type Spec = SaveFamilies['families'][string]
const specOf = ({ model, thinking, color }: FamilyView): Spec => ({ model, thinking, color })
const specsOf = (view: FamiliesView) =>
  Object.fromEntries(view.families.map((family) => [family.name, specOf(family)]))
const assignmentsOf = (view: FamiliesView) =>
  Object.fromEntries(Object.entries(view.assign).filter(([id]) => Object.hasOwn(FEATURES, id)))

async function saveFamilies(view: FamiliesView, change: Partial<SaveFamilies>) {
  await api.action(SaveFamiliesAction, {
    families: specsOf(view),
    assign: assignmentsOf(view),
    unpin: [],
    ...change,
  })
  await refreshFamilies()
}

export function moveFeature(view: FamiliesView, id: string, family: string) {
  const user = view.users.find((item) => item.id === id)
  return saveFamilies(view, {
    assign: { ...assignmentsOf(view), [id]: family },
    unpin: user?.pinnedIn?.startsWith('user') ? [id] : [],
  })
}

export function FamilyPopover(props: {
  family: FamilyView
  view: FamiliesView
  class?: string
  title?: string
  children: JSX.Element
}) {
  const [open, setOpen] = createSignal(false)
  return (
    <Popover open={open()} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`Edit ${props.family.name} model family`}
        class={props.class}
        title={props.title}
      >
        {props.children}
      </PopoverTrigger>
      <PopoverContent align="start" class="w-80 p-0">
        <Show when={open()}>
          <FamilyForm close={() => setOpen(false)} family={props.family} view={props.view} />
        </Show>
      </PopoverContent>
    </Popover>
  )
}

function FamilyForm(props: { family: FamilyView; view: FamiliesView; close: () => void }) {
  const models = useModels()
  const initial = untrack(() => specOf(props.family))
  const [draft, setDraft] = createSignal(initial)
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const name = () => props.family.name
  const model = () => draft().model ?? props.family.follows
  const info = createMemo(() =>
    models()?.models.find((item) => `${item.provider}/${item.id}` === model()),
  )
  const levels = createMemo(() => {
    const choices = new Set<NonNullable<Spec['thinking']> | ''>()
    if (!BUILTIN_FAMILIES[name()]?.thinking) choices.add('')
    const selected = draft().thinking
    const entry = info()
    for (const level of entry?.reasoning ? entry.thinkingLevels : entry ? ['off' as const] : [])
      choices.add(level)
    if (selected) choices.add(selected)
    return [...choices]
  })
  const followsThinking = () => name() === DEFAULT_FAMILY && props.family.followsThinking
  const thinkingLabel = (value: string) =>
    value || (followsThinking() ? `Pi's default · ${followsThinking()}` : 'inherit')
  const follows = () => props.family.follows
  const defaultModel = () => follows() && `Pi's default · ${modelIdOf(follows()!)}`
  const set = (change: Partial<Spec>) => {
    setDraft((previous) => ({ ...previous, ...change }))
    setError(undefined)
  }
  async function apply(next?: Spec) {
    if (pending()) return
    setPending(true)
    setError(undefined)
    const families = specsOf(props.view)
    if (next) families[name()] = next
    else delete families[name()]
    try {
      await saveFamilies(props.view, { families })
      props.close()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setPending(false)
    }
  }
  return (
    <Form class="flex flex-col gap-3 p-3">
      <div class="flex items-center gap-2">
        <span class="font-mono text-[12.5px] font-medium">{familyTitle(name())}</span>
        <Show when={props.family.project}>
          <span class="section-label">· the project's settings change it</span>
        </Show>
        <SegmentedControl
          aria-label={`Choose ${name()} family palette`}
          bind={[() => draft().color, (color) => set({ color })]}
          class="ml-auto gap-1 border-0 p-0"
        >
          <For each={colors}>
            {(color) => (
              <SegmentedControlItem
                aria-label={`${color} swatch for ${name()} family`}
                class="size-3 rounded-full p-0 ring-offset-1 ring-offset-popover hover:ring-1 hover:ring-foreground/40 data-checked:ring-1 data-checked:ring-foreground/70"
                style={{ 'background-color': familyColor(color) }}
                title={color}
                value={color}
              />
            )}
          </For>
        </SegmentedControl>
      </div>
      <div class="flex flex-col gap-1">
        <div class="section-label">Model</div>
        <ModelSelect
          class={control}
          inherit={name() === DEFAULT_FAMILY && draft().model ? defaultModel() : undefined}
          name={`${name()} family`}
          onChange={(next) => set({ model: next })}
          placeholder={defaultModel()}
          value={draft().model}
        />
        <Show when={model() && (!info() || !info()?.available)}>
          <p class="text-[11px] text-warning">
            {info() ? `No ${info()?.provider} login: ` : 'Not in the model list: '}
            what runs on it takes the default model until there is one.
          </p>
        </Show>
      </div>
      <div class="flex flex-col gap-1">
        <div class="section-label">Thinking</div>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`Reasoning level for ${name()} family`}
            class={`${control} flex items-center justify-between`}
          >
            {thinkingLabel(draft().thinking ?? '')}
            <ChevronDown class="size-3 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" class="font-mono">
            <DropdownMenuRadioGroup
              bind={[
                () => draft().thinking ?? 'inherit',
                (value) =>
                  set({ thinking: value === 'inherit' ? undefined : (value as Spec['thinking']) }),
              ]}
            >
              <For each={levels()}>
                {(level) => (
                  <DropdownMenuRadioItem
                    aria-label={`Set ${name()} family to ${thinkingLabel(level)}`}
                    value={level || 'inherit'}
                  >
                    {thinkingLabel(level)}
                  </DropdownMenuRadioItem>
                )}
              </For>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Show when={error()}>
        <p class="font-mono text-[11px] break-words text-error">{error()}</p>
      </Show>
      <div class="flex items-center gap-1 border-t border-border/70 pt-2.5">
        <Show when={!Object.hasOwn(BUILTIN_FAMILIES, name())}>
          <Button
            aria-label={`Remove ${name()} family`}
            class="h-7 px-2 text-[12px] text-muted-foreground hover:text-error"
            data-agent-confirm={`Remove ${name()}? What runs on it goes back to the Ultimate family.`}
            disabled={pending()}
            onClick={() => apply()}
            size="sm"
            title="What runs on it goes back to the Ultimate family"
            variant="ghost"
          >
            Remove
          </Button>
        </Show>
        <Button
          aria-label={`Discard changes to ${name()} family`}
          class="ml-auto h-7 px-2 text-[12px]"
          onClick={() => props.close()}
          size="sm"
          variant="ghost"
        >
          Cancel
        </Button>
        <Button
          aria-label={`Save changes to ${name()} family`}
          class="h-7 px-3 text-[12px]"
          disabled={JSON.stringify(draft()) === JSON.stringify(initial) || pending()}
          onClick={() => apply(draft())}
          title="New conversations take it; open ones keep their model"
          size="sm"
          type="submit"
        >
          {pending() ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Form>
  )
}

export function AddFamily(props: { view: FamiliesView }) {
  const [open, setOpen] = createSignal(false)
  const [input, setInput] = createSignal('')
  const [error, setError] = createSignal<string>()
  const name = () => input().trim().toLowerCase()
  const problem = () => {
    if (!name()) return undefined
    if (!isFamilyName(name())) return 'Lowercase letters, digits and - only'
    if (props.view.families.some((family) => family.name === name()))
      return 'There is a family of that name'
    return undefined
  }
  async function add() {
    if (!name() || problem()) return
    const view = props.view
    try {
      await saveFamilies(view, {
        families: {
          ...specsOf(view),
          [name()]: { color: colors[view.families.length % colors.length] },
        },
      })
      setInput('')
      setOpen(false)
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }
  return (
    <Popover open={open()} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Open new model family form"
        class="inline-flex h-5 items-center gap-1 rounded-md px-1.5 font-mono text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        title="A new model family"
      >
        <Plus class="size-3" /> Family
      </PopoverTrigger>
      <PopoverContent align="end" class="w-60 p-3">
        <Form class="space-y-2">
          <div class="section-label">New family</div>
          <Input
            aria-invalid={problem() ? 'true' : undefined}
            aria-label="Family identifier"
            class={control}
            onValueChange={(value) => {
              setInput(value)
              setError(undefined)
            }}
            placeholder="local"
            value={input()}
          />
          <Show when={problem() ?? error()}>
            <p class="text-[11px] text-error">{problem() ?? error()}</p>
          </Show>
          <Button
            class="h-7 w-full text-[12px]"
            disabled={!name() || !!problem()}
            onClick={add}
            size="sm"
            type="submit"
            variant="outline"
          >
            Add family
          </Button>
        </Form>
      </PopoverContent>
    </Popover>
  )
}
