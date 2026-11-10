import {
  BrainIcon,
  CheckIcon,
  KeyRoundIcon,
  LayersIcon,
  LogInIcon,
  TerminalIcon,
} from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { api, cn, errorMessage, useDialog, useUltimate } from '@/sdk'
import { familyTitle } from '../../lib/families.ts'
import {
  agentsPanel,
  FamilyDot,
  familyOf,
  modelIdOf,
  runsOn,
  thinkingOf,
  useFamilies,
} from './families.tsx'
import { SetFamilyAction } from './refs.ts'
import type { FamilyView } from './refs.ts'
import {
  authLabel,
  dialogs,
  formatWindow,
  notePick,
  openLogin,
  price,
  selectModel,
  useCurrentModel,
  usePickerTarget,
} from './state.tsx'
import type { ModelInfo, ProviderInfo } from './state.tsx'

const LIMIT = 150

/** Every term of the query appears in the model's provider, id, or name. */
function matches(model: ModelInfo, terms: readonly string[]) {
  const haystack = `${model.provider}/${model.id} ${model.name}`.toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

export function ModelRow({
  model,
  current,
  disabled,
  onSelect,
}: {
  model: ModelInfo
  current: boolean
  disabled?: boolean
  onSelect: () => void
}) {
  return (
    <CommandItem
      className={cn('gap-2 py-1 font-mono text-[12px]', !model.available && 'opacity-60')}
      disabled={disabled}
      onSelect={onSelect}
      value={`${model.provider}/${model.id}`}
    >
      <CheckIcon className={cn('size-3.5', current ? 'text-brand' : 'opacity-0')} />
      <span className={cn('shrink-0', current ? 'text-brand' : 'text-foreground')}>{model.id}</span>
      {model.name !== model.id && (
        <span className="min-w-0 truncate font-sans text-[12px] text-muted-foreground/80">
          {model.name}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-3 pl-3 text-[11px] text-muted-foreground tabular-nums">
        {model.provider === 'anthropic' && <span className="text-warning/80">paid API</span>}
        {model.reasoning ? (
          <span
            className="flex items-center gap-1"
            title={`thinking: ${model.thinkingLevels.join(' ')}`}
          >
            <BrainIcon className="size-3" />
            {model.thinkingLevels.filter((level) => level !== 'off').at(-1)}
          </span>
        ) : (
          <span className="text-muted-foreground/40">no thinking</span>
        )}
        <span className="w-11 text-right" title="context window">
          {formatWindow(model.contextWindow)}
        </span>
        <span className="w-20 text-right max-sm:hidden" title="$ per million input / output tokens">
          ${price(model.cost.input)}/{price(model.cost.output)}
        </span>
      </span>
    </CommandItem>
  )
}

/** Searchable models of every provider, grouped; picking one configures the conversation that opened it. */
export function ModelPicker() {
  const [open, setOpen] = useDialog(dialogs.picker)
  const actions = useUltimate()
  const {
    id,
    ref,
    thinking,
    family: recorded,
    models,
    loading,
  } = useCurrentModel(usePickerTarget())
  const families = useFamilies()
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string>()
  // The highlighted row: the reader's, once they move it; until then the current family or model, which may load after
  // the picker opens (cmdk reads `defaultValue` only on mount and otherwise highlights the first row).
  const [highlighted, setHighlighted] = useState<string>()
  const providers = useMemo(
    () => new Map((models?.providers ?? []).map((provider) => [provider.id, provider])),
    [models],
  )
  const groups = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const all = models?.models ?? []
    // Without a query: what can run now. With one: everything that matches, runnable and direct matches first
    // (`claude-opus-4-8` before a reseller's `eu.anthropic.claude-opus-4-8`). A Claude model Claude Code also offers
    // lists it before the paid Anthropic API even while logged out, so Enter never picks the paid one by accident.
    const claude = new Set(
      all.filter((model) => model.provider === 'claude-code').map((model) => model.id),
    )
    const twin = (model: ModelInfo) => claude.has(model.id)
    const rank = (model: ModelInfo) =>
      (model.available || (model.provider === 'claude-code' && terms.length) ? 0 : 2) +
      (model.provider === 'anthropic' && twin(model) ? 0.5 : 0) +
      (terms.length && !model.id.toLowerCase().startsWith(terms[0]) ? 1 : 0)
    const found = (
      terms.length
        ? all.filter((model) => matches(model, terms))
        : all.filter((model) => model.available)
    )
      .toSorted((a, b) => rank(a) - rank(b))
      .slice(0, LIMIT)
    return [...Map.groupBy(found, (model) => model.provider)]
  }, [models, query])
  const current = familyOf(families, ref, thinking, recorded)
  const shownFamilies = (families?.families ?? []).filter((family) => {
    const haystack = `${family.name} ${runsOn(family) ?? ''} ${thinkingOf(family) ?? ''}`
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    return runsOn(family) && terms.every((term) => haystack.toLowerCase().includes(term))
  })
  const total = models?.models.length ?? 0

  function choose(model: ModelInfo) {
    if (loading) return
    if (!model.available) {
      if (model.provider === 'claude-code') {
        setOpen(false)
        actions.openPanel('claude-code')
        return
      }
      openLogin({ ...actions, conversationId: id }, model.provider)
      return
    }
    setError(undefined)
    selectModel(model, id).then(
      () => setOpen(false),
      (failure: unknown) => setError(errorMessage(failure)),
    )
  }

  /** A family's model and thinking level for this conversation; a model without a login opens its login first. */
  function chooseFamily(family: FamilyView) {
    const name = runsOn(family)!
    const [provider, modelId] = [name.slice(0, name.indexOf('/')), modelIdOf(name)]
    const model = models?.models.find((m) => m.provider === provider && m.id === modelId)
    if (loading) return
    if (model && !model.available) return choose(model)
    setError(undefined)
    const level = thinkingOf(family)
    api
      .configure({ model: { provider, modelId }, ...(level ? { thinkingLevel: level } : {}) }, id)
      .then(() => api.action(SetFamilyAction, { family: family.name }, { conversationId: id }))
      .then(
        () => {
          notePick()
          setOpen(false)
        },
        (failure: unknown) => setError(errorMessage(failure)),
      )
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setQuery('')
          setError(undefined)
          setHighlighted(undefined)
        }
      }}
      open={open}
    >
      <DialogContent
        className="top-[16%] translate-y-0 gap-0 overflow-hidden p-0 font-mono sm:max-w-2xl"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Pick a model</DialogTitle>
        <DialogDescription className="sr-only">
          Search models by provider, id, or name. Unavailable Claude Code models open external
          setup; other models you are not logged in for open the login.
        </DialogDescription>
        <Command
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:section-label"
          onValueChange={setHighlighted}
          shouldFilter={false}
          value={
            highlighted ??
            (current && shownFamilies.includes(current)
              ? `family/${current.name}`
              : ref
                ? `${ref.provider}/${ref.modelId}`
                : undefined)
          }
        >
          <CommandInput
            className="text-[13px]"
            onValueChange={setQuery}
            placeholder={`Search ${total.toLocaleString()} models…`}
            value={query}
          />
          <CommandList className="max-h-[55vh]">
            <CommandEmpty className="py-6 text-center text-[12px] text-muted-foreground">
              No model matches. Log in to a provider to see its models.
            </CommandEmpty>
            {shownFamilies.length > 0 && (
              <CommandGroup heading="Families">
                {shownFamilies.map((family) => (
                  <CommandItem
                    className="gap-2 py-1 font-mono text-[12px]"
                    key={family.name}
                    onSelect={() => chooseFamily(family)}
                    value={`family/${family.name}`}
                  >
                    <CheckIcon
                      className={cn('size-3.5', current === family ? 'text-brand' : 'opacity-0')}
                    />
                    <FamilyDot color={family.color} />
                    <span className="shrink-0 font-sans text-foreground">
                      {familyTitle(family.name)}
                    </span>
                    <span className="ml-auto truncate pl-3 text-[11px] text-muted-foreground">
                      {[modelIdOf(runsOn(family)!), thinkingOf(family)].filter(Boolean).join(' · ')}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {groups.map(([provider, items]) => (
              <Fragment key={provider}>
                <CommandGroup
                  heading={<ProviderHeading provider={providers.get(provider)} id={provider} />}
                >
                  {items.map((model) => (
                    <ModelRow
                      current={model.provider === ref?.provider && model.id === ref.modelId}
                      key={`${model.provider}/${model.id}`}
                      model={model}
                      onSelect={() => choose(model)}
                    />
                  ))}
                </CommandGroup>
              </Fragment>
            ))}
            <CommandGroup heading="Accounts">
              <CommandItem
                className="gap-2 py-1 font-mono text-[12px]"
                onSelect={() => {
                  setOpen(false)
                  actions.openPanel(agentsPanel)
                }}
                value="families"
              >
                <LayersIcon className="size-3.5" />
                Model families…
                <span className="ml-auto text-[11px] text-muted-foreground">
                  each agent's family and model
                </span>
              </CommandItem>
              <CommandItem
                className="gap-2 py-1 font-mono text-[12px]"
                onSelect={() => openLogin({ ...actions, conversationId: id })}
                value="login"
              >
                <LogInIcon className="size-3.5" />
                Log in to a provider…
                <span className="ml-auto text-[11px] text-muted-foreground">
                  subscriptions and API keys, shared with pi
                </span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
          <div className="flex items-center gap-3 border-t border-border/70 px-3 py-1.5 text-[11px] text-muted-foreground">
            {error ? (
              <span className="truncate text-error">{error}</span>
            ) : (
              <>
                <span>
                  <Kbd>↵</Kbd> use
                </span>
                <span>
                  <Kbd>esc</Kbd> close
                </span>
                <span className="ml-auto">
                  {query ? 'all providers' : 'logged-in providers · type to search all'}
                </span>
              </>
            )}
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function ProviderHeading({ id, provider }: { id: string; provider: ProviderInfo | undefined }) {
  const label = authLabel(provider)
  return (
    <span className="flex items-center gap-2">
      {id}
      {provider && provider.name !== id && (
        <span className="truncate text-muted-foreground/60">{provider.name}</span>
      )}
      {label ? (
        <span className="ml-auto text-success/80">
          ✓ {label}
          {provider?.isUsingSubscription ? ' · subscription' : ''}
        </span>
      ) : id === 'claude-code' ? (
        <span className="ml-auto flex items-center gap-1 text-warning/80">
          <TerminalIcon className="size-3" />
          external setup · ↵ opens setup
        </span>
      ) : (
        <span className="ml-auto flex items-center gap-1 text-warning/80">
          <KeyRoundIcon className="size-3" />
          not logged in · ↵ logs in
        </span>
      )}
    </span>
  )
}
