import { CheckIcon } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { api, cn, errorMessage, useDialog, useModels } from '@/sdk'
import { ModelRow } from '../models/ui.tsx'
import { SetSummaryModelAction, SummaryModelAction } from './refs.ts'
import type { SummaryModelSetting } from './refs.ts'
import { parseSummaryModel } from './summary-model-ref.ts'
export const summaryModelDialog = 'conversations.summary-model'

/**
 * Picks the model for titles, summaries, assessments and conclusions, saved as `summaryModel` in the user's settings.
 * It shows the effective value and where it comes from. A project's setting overrides the user's and is never written
 * here: while it applies, picking is disabled.
 */
export function SummaryModelDialog() {
  const [open, setOpen] = useDialog(summaryModelDialog)
  const models = useModels()
  const [setting, setSetting] = useState<SummaryModelSetting>()
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!open) return
    setError(undefined)
    setQuery('')
    api
      .action(SummaryModelAction)
      .then(setSetting, (failure: unknown) => setError(errorMessage(failure)))
  }, [open])
  const current = typeof setting?.value === 'string' ? setting.value : undefined
  const parsed = current === undefined ? undefined : parseSummaryModel(current)
  const ref = parsed && `${parsed.provider}/${parsed.id}`
  const locked = setting?.source === 'project'
  const groups = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const found = (models?.models ?? []).filter(
      (model) =>
        model.available &&
        terms.every((term) =>
          `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(term),
        ),
    )
    return [...Map.groupBy(found.slice(0, 150), (model) => model.provider)]
  }, [models, query])
  const choose = async (value: string | null) => {
    setError(undefined)
    try {
      const next = await api.action(SetSummaryModelAction, {
        value,
      })
      setSetting(next)
      setOpen(false)
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent
        className="top-[16%] translate-y-0 gap-0 overflow-hidden p-0 font-mono sm:max-w-2xl"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Summary model</DialogTitle>
        <DialogDescription className="sr-only">
          The model that writes titles, summaries and reply summaries.
        </DialogDescription>
        <div className="flex items-baseline gap-2 border-b border-border/70 px-3 py-2 text-[0.75rem]">
          <span className="text-muted-foreground">Summary model</span>
          <span className="min-w-0 truncate text-foreground" data-testid="summary-model-current">
            {setting ? String(setting.value) : '…'}
          </span>
          {setting && (
            <span className="ml-auto shrink-0 text-[0.6875rem] text-muted-foreground">
              {setting.source === 'default'
                ? 'default'
                : setting.source === 'user'
                  ? '~/.ultimate/settings.json'
                  : 'set by project settings'}
            </span>
          )}
        </div>
        <Command
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:section-label"
          key={setting?.source}
          defaultValue={setting?.source === 'default' ? 'default' : ref}
          shouldFilter={false}
        >
          <CommandInput
            className="text-[0.8125rem]"
            onValueChange={setQuery}
            placeholder="Search logged-in models…"
            value={query}
          />
          <CommandList className="max-h-[50vh]">
            <CommandEmpty className="py-6 text-center text-[0.75rem] text-muted-foreground">
              No logged-in model matches.
            </CommandEmpty>
            {!query && setting && (
              <CommandGroup heading="Default">
                <CommandItem
                  className="gap-2 py-1 font-mono text-[0.75rem]"
                  disabled={locked}
                  onSelect={() => void choose(null)}
                  value="default"
                >
                  <CheckIcon
                    className={cn(
                      'size-3.5',
                      setting.source === 'default' ? 'text-brand' : 'opacity-0',
                    )}
                  />
                  Use the default
                  <span className="truncate text-muted-foreground">{setting.default}</span>
                </CommandItem>
              </CommandGroup>
            )}
            {groups.map(([provider, items]) => (
              <Fragment key={provider}>
                <CommandGroup heading={provider}>
                  {items.map((model) => (
                    <ModelRow
                      current={
                        setting?.source !== 'default' && ref === `${model.provider}/${model.id}`
                      }
                      disabled={locked}
                      key={`${model.provider}/${model.id}`}
                      model={model}
                      onSelect={() => void choose(`${model.provider}/${model.id}`)}
                    />
                  ))}
                </CommandGroup>
              </Fragment>
            ))}
          </CommandList>
          <div className="border-t border-border/70 px-3 py-1.5 text-[0.6875rem] text-muted-foreground">
            {error ? (
              <span className="text-error">{error}</span>
            ) : locked ? (
              `Set by project settings: edit ${setting.path} to change it`
            ) : (
              'Titles, summaries, assessments and conclusions · saved in ~/.ultimate/settings.json'
            )}
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
