/** @jsxImportSource @solidjs/web */
import { Check } from '@lucide/solid'
import { createMemo, createSignal, For, Show } from 'solid-js'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command.solid.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog.solid.tsx'
import { api, cn, errorMessage, useAction, useDialog, useModels, writingAs } from '@/sdk/solid'
import { ModelRow } from '../models/ui.solid.tsx'
import { SetSummaryModelAction, SummaryModelAction } from './refs.ts'
import { parseSummaryModel } from './summary-model-ref.ts'

export const summaryModelDialog = 'conversations.summary-model'

export function SummaryModelDialog() {
  const [open, setOpen] = useDialog(summaryModelDialog)
  return (
    <Dialog open={open()} onOpenChange={setOpen}>
      <DialogContent
        class="top-[16%] translate-y-0 grid-cols-[minmax(0,1fr)] gap-0 overflow-hidden p-0 font-mono sm:max-w-2xl"
        showCloseButton={false}
      >
        <DialogTitle class="sr-only">Summary model</DialogTitle>
        <DialogDescription class="sr-only">
          The model that writes titles, summaries and reply summaries.
        </DialogDescription>
        <Show when={open()}>
          <SummaryChoices close={() => setOpen(false)} />
        </Show>
      </DialogContent>
    </Dialog>
  )
}

function SummaryChoices(props: { close: () => void }) {
  const models = useModels()
  const setting = useAction(SummaryModelAction)
  const [query, setQuery] = createSignal('')
  const [error, setError] = createSignal<string>()
  const [highlight, setHighlight] = createSignal<string | null>()
  const choice = createMemo(() => {
    const data = setting.data()
    if (data?.source === 'default') return 'default'
    const ref = typeof data?.value === 'string' && parseSummaryModel(data.value)
    return ref ? `${ref.provider}/${ref.id}` : undefined
  })
  const locked = () => setting.data()?.source === 'project'
  const groups = createMemo(() => {
    const terms = query().toLowerCase().split(/\s+/).filter(Boolean)
    const found = (models()?.models ?? []).filter(
      (model) =>
        model.available &&
        terms.every((term) =>
          `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(term),
        ),
    )
    return [...Map.groupBy(found.slice(0, 150), (model) => model.provider)]
  })
  const firstMatch = () => {
    const model = groups()[0]?.[1][0]
    return model && `${model.provider}/${model.id}`
  }
  async function choose(value: string, source: string) {
    if (locked()) return
    const close = props.close
    setError(undefined)
    try {
      await api.action(SetSummaryModelAction, { value: value === 'default' ? null : value })
      void setting.refetch()
      writingAs(source, close)
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }
  return (
    <>
      <div class="flex items-baseline gap-2 border-b border-border/70 px-3 py-2 text-[12px]">
        <span class="text-muted-foreground">Summary model</span>
        <span class="min-w-0 truncate text-foreground" data-testid="summary-model-current">
          {setting.data() ? String(setting.data()?.value) : '…'}
        </span>
        <Show when={setting.data()}>
          {(data) => (
            <span class="ml-auto shrink-0 text-[11px] text-muted-foreground">
              {data().source === 'default'
                ? 'default'
                : data().source === 'user'
                  ? '~/.ultimate/settings.json'
                  : 'set by project settings'}
            </span>
          )}
        </Show>
      </div>
      <Command
        autoHighlight={false}
        filter={false}
        onAction={(value, details) => choose(value, details.source)}
        onQueryChange={(next) => {
          setQuery(next)
          setHighlight(undefined)
        }}
        onValueChange={setHighlight}
        query={query()}
        value={highlight() ?? (!query() ? choice() : undefined) ?? firstMatch()}
      >
        <CommandInput
          aria-label="Find a summary model"
          class="text-[13px]"
          placeholder="Search logged-in models…"
        />
        <CommandEmpty class="py-6 text-center text-[12px] text-muted-foreground">
          No logged-in model matches.
        </CommandEmpty>
        <CommandList class="max-h-[50vh]">
          <Show when={!query() && setting.data()}>
            {(data) => (
              <CommandGroup heading="Default">
                <CommandItem
                  class="gap-2 py-1 font-mono text-[12px]"
                  disabled={locked()}
                  value="default"
                >
                  <Check
                    class={cn('size-3.5', data().source === 'default' ? 'text-brand' : 'opacity-0')}
                  />
                  Use the default{' '}
                  <span class="truncate text-muted-foreground">{data().default}</span>
                </CommandItem>
              </CommandGroup>
            )}
          </Show>
          <For each={groups()} keyed={([provider]) => provider}>
            {(group) => (
              <CommandGroup heading={group()[0]}>
                <For each={group()[1]} keyed={(model) => model.id}>
                  {(model) => (
                    <ModelRow
                      current={choice() === `${model().provider}/${model().id}`}
                      disabled={locked()}
                      model={model()}
                    />
                  )}
                </For>
              </CommandGroup>
            )}
          </For>
        </CommandList>
        <div class="border-t border-border/70 px-3 py-1.5 text-[11px] text-muted-foreground">
          <Show
            when={error() ?? setting.error()?.message}
            fallback={
              locked()
                ? `Set by project settings: edit ${setting.data()?.path} to change it`
                : 'Titles, summaries, assessments and conclusions · saved in ~/.ultimate/settings.json'
            }
          >
            {(message) => <span class="text-error">{message()}</span>}
          </Show>
        </div>
      </Command>
    </>
  )
}
