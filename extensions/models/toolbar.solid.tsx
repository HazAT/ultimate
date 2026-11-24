import { Check, ChevronDown, Cpu, LoaderCircle, Search } from '@lucide/solid'
import { createMemo, createSignal, For, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Kbd } from '@/components/ui/kbd.solid.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.solid.tsx'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control.solid.tsx'
import { api, cn, errorMessage, useDialog, useModels, writingAs } from '@/sdk/solid'
import type { ConversationId } from '@earendil-works/pi-durable'
import { familyTitle } from '../../lib/families.ts'
import type { FamiliesView, FamilyView } from './refs.ts'
import { familyOf, modelIdOf, runsOn, thinkingOf } from './family-state.ts'
import { selectModel } from './picker.solid.tsx'
import { FamilyDot, useCurrentModel, useFamilies } from './readers.solid.tsx'
import { dialogs, pickerTarget, thinkingDialog } from './state.ts'
import type { ModelInfo, ThinkingLevel } from './state.ts'

const toolbarButton =
  'flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-md px-2 font-mono text-[11.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-open:bg-accent data-open:text-foreground'
const Down = () => <ChevronDown class="size-3 shrink-0 opacity-60 @max-md:hidden" />

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
        const writes = createWrites()
        return (
          <Popover onOpenChange={setOpen} open={open()}>
            <PopoverTrigger
              aria-label="Model and thinking"
              class={cn(toolbarButton, 'min-w-0 shrink')}
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
                families={families()}
                writes={writes}
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
  return (
    <>
      <Show when={props.family} fallback={<Cpu class="size-3.5 shrink-0" />}>
        {(family) => <FamilyDot color={family().color} class="mx-0.5" />}
      </Show>
      <span class={cn('truncate', props.modelId ? 'text-foreground/85' : 'text-warning')}>
        {props.family ? familyTitle(props.family.name) : (props.modelId ?? 'no model')}
      </span>
      <Show when={props.model?.reasoning}>
        <span class="shrink-0 opacity-50">·</span>
        <span class="shrink-0">{props.thinking}</span>
      </Show>
      <Down />
    </>
  )
}

function createWrites() {
  const [error, setError] = createSignal<string>()
  const [pending, setPending] = createSignal<string>()
  let changing = false
  async function run(key: string, write: () => Promise<unknown>, done?: () => void) {
    if (changing) return
    changing = true
    setPending(key)
    setError(undefined)
    try {
      await write()
      done?.()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      changing = false
      setPending(undefined)
    }
  }
  return { error, pending, run }
}

function Options(props: {
  id: ConversationId
  families: FamiliesView | undefined
  writes: ReturnType<typeof createWrites>
  current: string | undefined
  model: ModelInfo | undefined
  modelId: string | undefined
  thinking: ThinkingLevel
  close: () => void
}) {
  const models = useModels()
  const [, setPicker] = useDialog(dialogs.picker)
  const pending = () => props.writes.pending()
  const shown = createMemo(() =>
    (props.families?.families ?? []).filter((family) => runsOn(family)),
  )

  function openPicker(source: string) {
    const close = props.close
    pickerTarget.set(props.id)
    writingAs(source, () => {
      close()
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
    if (available !== true) return openPicker(source)
    const id = props.id
    return props.writes.run(
      `family/${family.name}`,
      () => selectModel({ provider, modelId }, id, source, family),
      props.close,
    )
  }

  return (
    <>
      <div class="px-2 pt-1 pb-1.5 section-label">Model</div>
      <div class="max-h-[40vh] overflow-y-auto">
        <For each={shown()} keyed={(family) => family.name}>
          {(family) => (
            <Button
              aria-current={family().name === props.current ? 'true' : undefined}
              aria-label={`${family().name} family`}
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
      </div>
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
        <span class="shrink-0">Other model…</span>
        <Show when={!props.current && props.modelId}>
          <span class="ml-auto truncate pl-3 text-[11px] text-brand">{props.modelId}</span>
        </Show>
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
                  const id = props.id
                  if (level)
                    void props.writes.run(`thinking/${level}`, () =>
                      api.configure({ thinkingLevel: level }, id),
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
          when={props.writes.error()}
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
