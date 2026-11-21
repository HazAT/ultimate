/** @jsxImportSource @solidjs/web */
import { Check, KeyRound, Layers, LogIn, Terminal } from '@lucide/solid'
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
import { Kbd } from '@/components/ui/kbd.solid.tsx'
import {
  api,
  cn,
  ConversationScope,
  errorMessage,
  openPanel,
  useConversationId,
  useDialog,
  useExternal,
  useModels,
  writingAs,
} from '@/sdk/solid'
import type { ConversationId } from '@earendil-works/pi-durable'
import { familyTitle } from '../../lib/families.ts'
import { agentsPanel, familyOf, modelIdOf, runsOn, thinkingOf } from './family-state.ts'
import { FamilyDot, useCurrentModel, useFamilies } from './readers.solid.tsx'
import { SetFamilyAction } from './refs.ts'
import type { FamilyView } from './refs.ts'
import {
  authLabel,
  dialogs,
  loginProvider,
  matchesEveryQueryTerm,
  modelKey,
  notePick,
  pickerTarget,
  termsOf,
} from './state.ts'
import type { ModelInfo, ProviderInfo } from './state.ts'
import { ModelRow } from './ui.solid.tsx'

const LIMIT = 150
const row = 'gap-2 py-1 font-mono text-[12px]'

function rankModels(models: ModelInfo[], terms: string[]) {
  const claudeCodeIds = new Set(
    models.filter((model) => model.provider === 'claude-code').map((model) => model.id),
  )
  const runnableSubscriptionFirstRank = (model: ModelInfo) =>
    (model.available || (model.provider === 'claude-code' && terms.length) ? 0 : 2) +
    (model.provider === 'anthropic' && claudeCodeIds.has(model.id) ? 0.5 : 0) +
    (terms.length && !model.id.toLowerCase().startsWith(terms[0]) ? 1 : 0)
  return models
    .filter((model) => (terms.length ? matchesEveryQueryTerm(model, terms) : model.available))
    .toSorted((a, b) => runnableSubscriptionFirstRank(a) - runnableSubscriptionFirstRank(b))
    .slice(0, LIMIT)
}

async function selectModel(
  model: { provider: string; modelId: string },
  id: ConversationId | undefined,
  source: string,
  family: FamilyView | null = null,
) {
  const level = family && thinkingOf(family)
  await api.configure({ model, ...(level ? { thinkingLevel: level } : {}) }, id)
  await writingAs(source, () =>
    api.action(SetFamilyAction, { family: family?.name ?? null }, { conversationId: id }),
  )
  notePick()
}

export function ModelPicker() {
  const [open, setOpen] = useDialog(dialogs.picker)
  const target = useExternal(pickerTarget.get, pickerTarget.subscribe)
  const shown = useConversationId()
  const scope = () => (target() === shown() ? 'shown' : (target() ?? 'shown'))
  return (
    <Dialog onOpenChange={setOpen} open={open()}>
      <DialogContent
        class="top-[16%] translate-y-0 grid-cols-[minmax(0,1fr)] gap-0 overflow-hidden p-0 font-mono sm:max-w-2xl"
        showCloseButton={false}
      >
        <DialogTitle class="sr-only">Pick a model</DialogTitle>
        <DialogDescription class="sr-only">
          Search models by provider, id, or name. Unavailable Claude Code models open external
          setup; other models you are not logged in for open the login.
        </DialogDescription>
        <Show when={open() && scope()} keyed>
          {(conversation) => (
            <ConversationScope value={conversation === 'shown' ? null : conversation}>
              <Picker close={() => setOpen(false)} />
            </ConversationScope>
          )}
        </Show>
      </DialogContent>
    </Dialog>
  )
}

function Picker(props: { close: () => void }) {
  const { id, ref, thinking, recorded, loading } = useCurrentModel()
  const models = useModels()
  const families = useFamilies()
  const [, setLogin] = useDialog(dialogs.login)
  const [query, setQuery] = createSignal('')
  const [error, setError] = createSignal<string>()
  const [highlight, setHighlight] = createSignal<string | null>()
  const terms = createMemo(() => termsOf(query()))
  const found = createMemo(() => rankModels(models()?.models ?? [], terms()))
  const groups = createMemo(() => [...Map.groupBy(found(), (model) => model.provider)])
  const providers = createMemo(
    () => new Map(models()?.providers.map((provider) => [provider.id, provider])),
  )
  const current = createMemo(() => familyOf(families(), ref(), thinking(), recorded()?.name)?.name)
  const shownFamilies = createMemo(() =>
    (families()?.families ?? []).filter((family) => {
      const target = runsOn(family)
      const haystack = `${family.name} ${target ?? ''} ${thinkingOf(family) ?? ''}`.toLowerCase()
      return target && terms().every((term) => haystack.includes(term))
    }),
  )
  const currentModel = () => ref() && `${ref()!.provider}/${ref()!.modelId}`
  const firstMatch = () => {
    const family = shownFamilies()[0]
    const model = found()[0]
    return family ? `family/${family.name}` : model ? modelKey(model) : 'accounts/families'
  }
  const startAt = () => {
    if (!query()) {
      if (shownFamilies().some((family) => family.name === current())) return `family/${current()}`
      if (found().some((model) => modelKey(model) === currentModel())) return currentModel()
    }
    return firstMatch()
  }

  function login(provider?: string) {
    pickerTarget.set(id())
    loginProvider.set(provider)
    props.close()
    setLogin(true)
  }

  async function choose(
    model: { provider: string; modelId: string },
    source: string,
    family?: FamilyView,
  ) {
    if (loading()) return
    const close = props.close
    const catalogModel = models()?.models.find(
      (entry) => entry.provider === model.provider && entry.id === model.modelId,
    )
    if (catalogModel && !catalogModel.available) {
      if (model.provider === 'claude-code') {
        close()
        openPanel('claude-code')
      } else login(model.provider)
      return
    }
    setError(undefined)
    try {
      await selectModel(model, id(), source, family)
      writingAs(source, close)
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }

  function chooseFamily(name: string, source: string) {
    const family = shownFamilies().find((entry) => entry.name === name)
    if (!family) return undefined
    const target = runsOn(family)!
    return choose(
      { provider: target.slice(0, target.indexOf('/')), modelId: modelIdOf(target) },
      source,
      family,
    )
  }

  function activate(value: string, source: string) {
    if (value === 'accounts/families') {
      props.close()
      openPanel(agentsPanel)
    } else if (value === 'accounts/login') login()
    else if (value.startsWith('family/')) return chooseFamily(value.slice(7), source)
    else {
      const model = found().find((entry) => modelKey(entry) === value)
      if (model) return choose({ provider: model.provider, modelId: model.id }, source)
    }
    return undefined
  }

  return (
    <Command
      autoHighlight={false}
      class="[&_[data-slot=command-group-label]]:pt-2 [&_[data-slot=command-group-label]]:pb-1 [&_[data-slot=command-group-label]]:section-label"
      filter={false}
      onAction={(value, details) => activate(value, details.source)}
      onQueryChange={(next) => {
        setQuery(next)
        setHighlight(undefined)
      }}
      onValueChange={setHighlight}
      query={query()}
      value={highlight() ?? startAt()}
    >
      <CommandInput
        aria-label="Search model catalog"
        class="text-[13px]"
        placeholder={`Search ${(models()?.models.length ?? 0).toLocaleString()} models…`}
      />
      <CommandEmpty class="py-6 text-center text-[12px] text-muted-foreground">
        No model matches. Log in to a provider to see its models.
      </CommandEmpty>
      <CommandList class="max-h-[55vh]">
        <CommandGroup heading="Families">
          <For each={shownFamilies()} keyed={(family) => family.name}>
            {(family) => (
              <CommandItem class={row} value={`family/${family().name}`}>
                <Check
                  class={cn('size-3.5', current() === family().name ? 'text-brand' : 'opacity-0')}
                />
                <FamilyDot color={family().color} />
                <span class="shrink-0 font-sans text-foreground">
                  {familyTitle(family().name)}
                </span>{' '}
                <span
                  aria-hidden="true"
                  class="ml-auto truncate pl-3 text-[11px] text-muted-foreground"
                >
                  {[modelIdOf(runsOn(family())!), thinkingOf(family())].filter(Boolean).join(' · ')}
                </span>
              </CommandItem>
            )}
          </For>
        </CommandGroup>
        <For each={groups()} keyed={([provider]) => provider}>
          {(group) => (
            <CommandGroup
              heading={<ProviderHeading id={group()[0]} provider={providers().get(group()[0])} />}
            >
              <For each={group()[1]} keyed={modelKey}>
                {(model) => (
                  <ModelRow current={modelKey(model()) === currentModel()} model={model()} />
                )}
              </For>
            </CommandGroup>
          )}
        </For>
        <CommandGroup heading="Accounts">
          <CommandItem class={row} value="accounts/families">
            <Layers class="size-3.5" />
            Model families…{' '}
            <span class="ml-auto text-[11px] text-muted-foreground">
              each agent's family and model
            </span>
          </CommandItem>
          <CommandItem class={row} value="accounts/login">
            <LogIn class="size-3.5" />
            Log in to a provider…{' '}
            <span class="ml-auto text-[11px] text-muted-foreground">
              subscriptions and API keys, shared with pi
            </span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
      <div class="flex items-center gap-3 border-t border-border/70 px-3 py-1.5 text-[11px] text-muted-foreground">
        <Show
          when={error()}
          fallback={
            <>
              <span>
                <Kbd>↵</Kbd> use
              </span>
              <span>
                <Kbd>esc</Kbd> close
              </span>
              <span class="ml-auto">
                {query() ? 'all providers' : 'logged-in providers · type to search all'}
              </span>
            </>
          }
        >
          {(message) => <span class="truncate text-error">{message()}</span>}
        </Show>
      </div>
    </Command>
  )
}

function ProviderHeading(props: { id: string; provider: ProviderInfo | undefined }) {
  return (
    <span class="flex items-center gap-2">
      {props.id}
      <Show when={props.provider && props.provider.name !== props.id}>
        <span class="truncate text-muted-foreground/60">{props.provider?.name}</span>
      </Show>
      <Show
        when={authLabel(props.provider)}
        fallback={
          props.id === 'claude-code' ? (
            <span class="ml-auto flex items-center gap-1 text-warning/80">
              <Terminal class="size-3" /> external setup · ↵ opens setup
            </span>
          ) : (
            <span class="ml-auto flex items-center gap-1 text-warning/80">
              <KeyRound class="size-3" /> not logged in · ↵ logs in
            </span>
          )
        }
      >
        {(label) => (
          <span class="ml-auto text-success/80">
            ✓ {label()}
            {props.provider?.isUsingSubscription ? ' · subscription' : ''}
          </span>
        )}
      </Show>
    </span>
  )
}
