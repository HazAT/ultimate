import { Brain, Check, ChevronDown, Cpu, LoaderCircle } from '@lucide/solid'
import { createSignal, For, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Kbd } from '@/components/ui/kbd.solid.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.solid.tsx'
import { api, cn, errorMessage, useDialog, writingAs } from '@/sdk/solid'
import type { ConversationId } from '@earendil-works/pi-durable'
import { familyTitle } from '../../lib/families.ts'
import { familyOf } from './family-state.ts'
import { FamilyDot, useCurrentModel, useFamilies } from './readers.solid.tsx'
import { dialogs, pickerTarget, thinkingDialog } from './state.ts'
import type { ModelInfo, ThinkingLevel } from './state.ts'

const toolbarButton =
  'flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-md px-2 font-mono text-[11.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-open:bg-accent data-open:text-foreground'
const Down = () => <ChevronDown class="size-3 shrink-0 opacity-60 @max-md:hidden" />

export function ModelButton() {
  const { id, ref, thinking, recorded, loading } = useCurrentModel()
  const families = useFamilies()
  const family = () => familyOf(families(), ref(), thinking(), recorded()?.name)
  const [, setPicker] = useDialog(dialogs.picker)
  return (
    <Button
      aria-label={loading() ? 'Loading model' : 'Open the model picker'}
      class={cn(toolbarButton, 'min-w-0 shrink')}
      disabled={loading()}
      onClick={() => {
        pickerTarget.set(id())
        setPicker(true)
      }}
      title={
        loading()
          ? 'Loading model'
          : ref()
            ? `${ref()!.modelId} · ${ref()!.provider} — pick a model`
            : 'Pick a model'
      }
      size={null}
      variant={null}
    >
      <Show when={!loading() && family()} fallback={<Cpu class="size-3.5 shrink-0" />}>
        {(current) => <FamilyDot color={current().color} class="mx-0.5" />}
      </Show>
      <span class={cn('truncate', !loading() && (ref() ? 'text-foreground/85' : 'text-warning'))}>
        {loading()
          ? 'model…'
          : family()
            ? `${familyTitle(family()!.name)} (${ref()!.modelId})`
            : (ref()?.modelId ?? 'no model')}
      </span>
      <Down />
    </Button>
  )
}

export function ThinkingButton() {
  const { id, model, thinking, loading } = useCurrentModel()
  return (
    <Show
      when={!loading()}
      fallback={
        <Button
          aria-label="Loading thinking level"
          class={toolbarButton}
          disabled
          size={null}
          title="Loading thinking level"
          variant={null}
        >
          <Brain class="size-3.5 shrink-0" /> thinking… <Down />
        </Button>
      }
    >
      <Show when={model()?.reasoning && id()} keyed>
        {(conversation) => {
          const [open, setOpen] = useDialog(thinkingDialog(conversation))
          return (
            <ThinkingPopover
              id={conversation}
              open={open()}
              setOpen={setOpen}
              levels={model()!.thinkingLevels}
              current={thinking() ?? 'off'}
            />
          )
        }}
      </Show>
    </Show>
  )
}

function ThinkingPopover(props: {
  id: ConversationId
  open: boolean
  setOpen: (open: boolean) => void
  levels: ModelInfo['thinkingLevels']
  current: ThinkingLevel
}) {
  return (
    <Popover onOpenChange={props.setOpen} open={props.open}>
      <PopoverTrigger
        aria-label="Thinking level"
        class={toolbarButton}
        title="Thinking level (Shift+Tab cycles)"
      >
        <Brain class={cn('size-3.5 shrink-0', props.current !== 'off' && 'text-brand')} />
        <span class={props.current !== 'off' ? 'text-foreground/85' : undefined}>
          {props.current}
        </span>
        <Down />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Reasoning effort options"
        class="w-48 p-1 font-mono"
        side="top"
      >
        <div class="px-2 pt-1 pb-1.5 section-label">Thinking</div>
        <ThinkingLevels
          id={props.id}
          levels={props.levels}
          current={props.current}
          close={() => props.setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  )
}

function ThinkingLevels(props: {
  id: ConversationId
  levels: ModelInfo['thinkingLevels']
  current: ThinkingLevel
  close: () => void
}) {
  const [error, setError] = createSignal<string>()
  const [pending, setPending] = createSignal<ThinkingLevel>()
  let changing = false
  async function choose(level: ThinkingLevel, source: string) {
    if (changing) return
    changing = true
    setPending(level)
    const close = props.close
    setError(undefined)
    try {
      await api.configure({ thinkingLevel: level }, props.id)
      writingAs(source, close)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      changing = false
      setPending(undefined)
    }
  }
  return (
    <>
      <For each={props.levels}>
        {(level) => (
          <Button
            aria-current={level === props.current ? 'true' : undefined}
            aria-label={`${level} effort`}
            data-selected={level === props.current ? '' : undefined}
            disabled={pending() !== undefined && pending() !== level}
            class="flex h-7 w-full items-center justify-start gap-2 rounded-sm px-2 text-left text-[12px] data-selected:text-brand"
            onClick={(_, details) => choose(level, details.source)}
            size={null}
            variant="ghost"
          >
            <LoaderCircle class="hidden size-3.5 motion-safe:animate-spin in-data-pending:block" />
            <Check class="size-3.5 opacity-0 in-data-selected:opacity-100 in-data-pending:hidden" />
            {level}
          </Button>
        )}
      </For>
      <div class="mt-1 flex items-center gap-1.5 border-t border-border/70 px-2 pt-1.5 pb-1 text-[11px] text-muted-foreground">
        <Show
          when={error()}
          fallback={
            <>
              <Kbd>⇧ Tab</Kbd> cycles
            </>
          }
        >
          {(message) => <span class="text-error">{message()}</span>}
        </Show>
      </div>
    </>
  )
}
