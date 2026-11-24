import { Check, ChevronDown, Cpu, LoaderCircle, Search, SlidersHorizontal } from '@lucide/solid'
import { createMemo, createSignal, For, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Kbd } from '@/components/ui/kbd.solid.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.solid.tsx'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control.solid.tsx'
import { api, cn, errorMessage, useDialog, useModels, writingAs } from '@/sdk/solid'
import type { ConversationId } from '@earendil-works/pi-durable'
import { familyTitle } from '../../lib/families.ts'
import type { FamilyView } from './refs.ts'
import { familyOf, modelIdOf, runsOn, thinkingOf } from './family-state.ts'
import { selectModel } from './picker.solid.tsx'
import { FamilyDot, useCurrentModel, useFamilies } from './readers.solid.tsx'
import { dialogs, pickerTarget, thinkingDialog } from './state.ts'
import type { ModelInfo, ThinkingLevel } from './state.ts'

type Variant = 'a' | 'b' | 'c'
const variantKey = 'models.toolbar.variant'
const [variant, setVariant] = createSignal<Variant>(
  (globalThis.localStorage?.getItem(variantKey) as Variant | null) ?? 'a',
)

const toolbarButton =
  'flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-md px-2 font-mono text-[11.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-open:bg-accent data-open:text-foreground'
const Down = () => <ChevronDown class="size-3 shrink-0 opacity-60 @max-md:hidden" />

export function VariantSwitch() {
  return (
    <SegmentedControl
      aria-label="Preview: model control variant"
      bind={[
        variant,
        (next) => {
          localStorage.setItem(variantKey, next)
          setVariant(next)
        },
      ]}
      class="ml-1 border-dashed"
      title="Preview only: switch between the three variations"
    >
      <For each={['a', 'b', 'c'] as const}>
        {(value) => <SegmentedControlItem value={value}>{value}</SegmentedControlItem>}
      </For>
    </SegmentedControl>
  )
}

export function ModelControl() {
  const current = useCurrentModel()
  const families = useFamilies()
  const family = createMemo(() =>
    familyOf(families(), current.ref(), current.thinking(), current.recorded()?.name),
  )
  return (
    <Show
      when={!current.loading() && current.id()}
      keyed
      fallback={
        <Button
          aria-label="Loading model"
          class={toolbarButton}
          disabled
          size={null}
          title="Loading model"
          variant={null}
        >
          <Cpu class="size-3.5 shrink-0" /> model… <Down />
        </Button>
      }
    >
      {(conversation) => {
        const [open, setOpen] = useDialog(thinkingDialog(conversation))
        return (
          <Popover onOpenChange={setOpen} open={open()}>
            <PopoverTrigger
              aria-label="Model and thinking"
              class={cn(toolbarButton, 'min-w-0 shrink', variant() !== 'a' && 'gap-1 px-1.5')}
              title={[
                family() ? familyTitle(family()!.name) : undefined,
                current.ref()?.modelId ?? 'no model',
                current.model()?.reasoning ? `thinking ${current.thinking() ?? 'off'}` : undefined,
              ]
                .filter(Boolean)
                .join(' · ')}
            >
              <Trigger
                family={family()}
                modelId={current.ref()?.modelId}
                model={current.model()}
                thinking={current.thinking() ?? 'off'}
              />
            </PopoverTrigger>
            <PopoverContent
              align="start"
              aria-label="Model and thinking options"
              class="w-80 p-1 font-mono"
              side="top"
            >
              <Options
                id={conversation}
                current={family()?.name}
                model={current.model()}
                modelId={current.ref()?.modelId}
                thinking={current.thinking() ?? 'off'}
                close={() => setOpen(false)}
              />
            </PopoverContent>
          </Popover>
        )
      }}
    </Show>
  )
}

function Trigger(props: {
  family: FamilyView | undefined
  modelId: string | undefined
  model: ModelInfo | undefined
  thinking: ThinkingLevel
}) {
  const name = () => (props.family ? familyTitle(props.family.name) : (props.modelId ?? 'no model'))
  const thinks = () => props.model?.reasoning === true
  return (
    <>
      <Show when={variant() === 'a'}>
        <Show when={props.family} fallback={<Cpu class="size-3.5 shrink-0" />}>
          {(family) => <FamilyDot color={family().color} class="mx-0.5" />}
        </Show>
        <span class={cn('truncate', props.modelId ? 'text-foreground/85' : 'text-warning')}>
          {name()}
        </span>
        <Show when={thinks()}>
          <span class="shrink-0 opacity-50">·</span>
          <span class="shrink-0">{props.thinking}</span>
        </Show>
        <Down />
      </Show>
      <Show when={variant() === 'b'}>
        <Show when={props.family} fallback={<Cpu class="size-3.5 shrink-0" />}>
          {(family) => <FamilyDot color={family().color} class="mx-0.5" />}
        </Show>
        <Show when={thinks() && props.model}>
          {(model) => <Bars levels={model().thinkingLevels} current={props.thinking} />}
        </Show>
      </Show>
      <Show when={variant() === 'c'}>
        <SlidersHorizontal class="size-3.5 shrink-0" />
      </Show>
    </>
  )
}

function Bars(props: { levels: ModelInfo['thinkingLevels']; current: ThinkingLevel }) {
  const filled = () => {
    const steps = props.levels.length - 1
    return steps ? Math.round((props.levels.indexOf(props.current) / steps) * 4) : 0
  }
  return (
    <span aria-hidden="true" class="flex h-3 shrink-0 items-end gap-[2px] px-0.5">
      <For each={[1, 2, 3, 4]}>
        {(bar) => (
          <span
            class={cn(
              'w-[2.5px] rounded-[1px]',
              bar <= filled() ? 'bg-brand' : 'bg-muted-foreground/30',
            )}
            style={{ height: `${3 + bar * 2}px` }}
          />
        )}
      </For>
    </span>
  )
}

function Options(props: {
  id: ConversationId
  current: string | undefined
  model: ModelInfo | undefined
  modelId: string | undefined
  thinking: ThinkingLevel
  close: () => void
}) {
  const families = useFamilies()
  const models = useModels()
  const [, setPicker] = useDialog(dialogs.picker)
  const [error, setError] = createSignal<string>()
  const [pending, setPending] = createSignal<string>()
  const shown = createMemo(() => (families()?.families ?? []).filter((family) => runsOn(family)))
  let changing = false

  async function run(key: string, write: () => Promise<unknown>, close: boolean) {
    if (changing) return
    changing = true
    setPending(key)
    setError(undefined)
    const done = props.close
    try {
      await write()
      if (close) done()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      changing = false
      setPending(undefined)
    }
  }

  function openPicker(source: string) {
    pickerTarget.set(props.id)
    writingAs(source, () => {
      props.close()
      setPicker(true)
    })
  }

  function chooseFamily(family: FamilyView, source: string) {
    const target = runsOn(family)!
    const provider = target.slice(0, target.indexOf('/'))
    const modelId = modelIdOf(target)
    const available = models()?.models.find(
      (entry) => entry.provider === provider && entry.id === modelId,
    )?.available
    if (available === false) return openPicker(source)
    return run(
      `family/${family.name}`,
      () => selectModel({ provider, modelId }, props.id, source, family),
      true,
    )
  }

  return (
    <>
      <div class="px-2 pt-1 pb-1.5 section-label">Model</div>
      <For each={shown()} keyed={(family) => family.name}>
        {(family) => (
          <Button
            aria-current={family().name === props.current ? 'true' : undefined}
            aria-label={`${familyTitle(family().name)} family`}
            class="flex h-7 w-full items-center justify-start gap-2 rounded-sm px-2 text-left text-[12px] font-normal"
            data-pending={pending() === `family/${family().name}` ? '' : undefined}
            disabled={pending() !== undefined}
            onClick={(_, details) => chooseFamily(family(), details.source)}
            size={null}
            variant="ghost"
          >
            <LoaderCircle class="hidden size-3.5 motion-safe:animate-spin in-data-pending:block" />
            <Check
              class={cn(
                'size-3.5 shrink-0 in-data-pending:hidden',
                family().name === props.current ? 'text-brand' : 'opacity-0',
              )}
            />
            <FamilyDot color={family().color} />
            <span class="shrink-0 font-sans text-foreground">{familyTitle(family().name)}</span>
            <span class="ml-auto truncate pl-3 text-[11px] text-muted-foreground">
              {[modelIdOf(runsOn(family())!), thinkingOf(family())].filter(Boolean).join(' · ')}
            </span>
          </Button>
        )}
      </For>
      <Button
        aria-label="Pick another model"
        class="flex h-7 w-full items-center justify-start gap-2 rounded-sm px-2 text-left text-[12px] font-normal text-muted-foreground"
        disabled={pending() !== undefined}
        onClick={(_, details) => openPicker(details.source)}
        size={null}
        variant="ghost"
      >
        <Show
          when={!props.current && props.modelId}
          fallback={<Search class="size-3.5 shrink-0" />}
        >
          <Check class="size-3.5 shrink-0 text-brand" />
        </Show>
        <span class="truncate">
          {!props.current && props.modelId ? props.modelId : 'Other model…'}
        </span>
      </Button>
      <Show when={props.model?.reasoning && props.model}>
        {(model) => (
          <>
            <div class="mt-1 border-t border-border/70 px-2 pt-2 pb-1.5 section-label">
              Thinking
            </div>
            <div class="px-1 pb-1">
              <SegmentedControl
                aria-label="Thinking level"
                class="w-full"
                disabled={pending() !== undefined}
                onValueChange={(level) => {
                  if (level)
                    void run(
                      `thinking/${level}`,
                      () => api.configure({ thinkingLevel: level }, props.id),
                      false,
                    )
                }}
                value={props.thinking}
              >
                <For each={model().thinkingLevels}>
                  {(level) => (
                    <SegmentedControlItem
                      aria-label={`${level} effort`}
                      class="flex-1 justify-center"
                      value={level}
                    >
                      {level}
                    </SegmentedControlItem>
                  )}
                </For>
              </SegmentedControl>
            </div>
          </>
        )}
      </Show>
      <div class="mt-1 flex items-center gap-1.5 border-t border-border/70 px-2 pt-1.5 pb-1 text-[11px] text-muted-foreground">
        <Show
          when={error()}
          fallback={
            <>
              <Kbd>⇧ Tab</Kbd> cycles thinking
            </>
          }
        >
          {(message) => <span class="text-error">{message()}</span>}
        </Show>
      </div>
    </>
  )
}
