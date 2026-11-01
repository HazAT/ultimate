import { BotIcon, CopyIcon, Trash2Icon, TriangleAlertIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  api,
  cn,
  errorMessage,
  events,
  shortenPath,
  useAction,
  useDialog,
  useEvent,
  useExtensionUiState,
  useModels,
  useSystem,
  useUltimate,
} from '@/sdk'
import { agentsPanel, FamilyLabel, refreshFamilies, useFamilies } from '../models/ui.tsx'
import {
  Field,
  InstructionsEditor,
  inputClass,
  ModelField,
  Segmented,
  ToolsField,
  StandingField,
  SummariesField,
  thinkingLevels,
} from './fields.tsx'
import { Tag } from './parts.tsx'
import {
  DefinitionAction,
  DefinitionsAction,
  DeleteDefinitionAction,
  SaveDefinitionAction,
} from './refs.ts'
import type { DefinitionFields, Discovery, ModelRef, Scope, Shown, Source } from './refs.ts'

/**
 * The config dialog's id, and the UI state naming the definition it shows ('' for a new one); both are this extension's
 * own. Another extension opens a definition over the bus: `subagents:open-definition { name }`, answered by
 * `subagents:definition-closed { name }` once the dialog closes.
 */
export const definitionDialog = 'subagents.definition'
const shownKey = 'definition'

export const sourceLabel: Record<Source, string> = {
  builtin: 'built-in',
  user: 'user',
  project: 'project',
}
export const parseError = (error: string) => error.replace(/^Error: /, '')
/** Opens the config dialog on a definition, or on a new one with `''`. */
export function useOpenDefinition() {
  const { open } = useUltimate()
  const [, setShown] = useExtensionUiState(shownKey, '')
  return (name: string) => {
    setShown(name)
    open(definitionDialog)
  }
}

/** The frontmatter a save writes for a definition as `draft` has it. */
const fieldsOf = (draft: Draft): DefinitionFields => ({
  description: draft.description,
  ...(draft.model ? { model: `${draft.model.provider}/${draft.model.modelId}` } : {}),
  ...(draft.thinking ? { thinking: draft.thinking } : {}),
  ...(!draft.model && draft.family ? { family: draft.family } : {}),
  ...(draft.tools ? { tools: draft.tools } : {}),
  ...(draft.denyTools.length ? { denyTools: draft.denyTools } : {}),
  resident: draft.resident,
  ...(draft.isolate === 'worktree' ? { isolate: 'worktree' as const } : {}),
  ...(draft.fast ? { fast: true } : {}),
  ...(draft.summaries ? {} : { summaries: false }),
})

/**
 * Move definition `name` to `family`, as the dialog would save it: a definition of the user's or the project's is
 * rewritten in place; a built-in gets an overlay holding only the family, in the project when its setup is trusted.
 * A pinned model gives way to the family. Returns the file written.
 */
export async function moveDefinition(name: string, family: string, discovery: Discovery) {
  const shown = await api.action(DefinitionAction, { name })
  if (!shown.definition) throw new Error(`${name} fails to parse: open it to fix it`)
  const overlayScope = shown.definition.overlays?.at(-1)?.startsWith(`${discovery.scopes.project}/`)
    ? 'project'
    : shown.definition.overlays?.length
      ? 'user'
      : undefined
  const scope: Scope =
    overlayScope ??
    (shown.source === 'builtin'
      ? discovery.projectSetup === 'trusted'
        ? 'project'
        : 'user'
      : shown.source)
  const draft = { ...draftOf(shown.definition), family, model: null }
  await api.action(SaveDefinitionAction, {
    name,
    scope,
    frontmatter: fieldsOf(draft),
    instructions: draft.instructions,
    overlay: true,
  })
  await refreshFamilies()
  return `${discovery.scopes[scope]}/${name}.md`
}

/** The config dialog, mounted in the overlay so other extensions can open it too. */
export function DefinitionDialog() {
  const [open, setOpen] = useDialog(definitionDialog)
  const [shown, setShown] = useExtensionUiState(shownKey, '')
  const show = useOpenDefinition()
  useEvent('subagents:open-definition', (data) => {
    const name = (data as { name?: unknown } | undefined)?.name
    if (typeof name === 'string') show(name)
  })
  const wasOpen = useRef(open)
  useEffect(() => {
    if (wasOpen.current && !open) events.emit('subagents:definition-closed', { name: shown })
    wasOpen.current = open
  }, [open, shown])
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent
        className="flex h-[min(88vh,52rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
        showCloseButton={false}
      >
        {open && <Loader close={() => setOpen(false)} key={shown} name={shown} show={setShown} />}
      </DialogContent>
    </Dialog>
  )
}

/** Fetches what the form needs, and remounts it with fresh values after each save. */
function Loader({
  name,
  show,
  close,
}: {
  name: string
  show: (name: string) => void
  close: () => void
}) {
  const discovery = useAction(DefinitionsAction)
  // Shown inline, as the dialog's content, rather than as a notice.
  const shown = useAction(DefinitionAction, { name }, { enabled: name !== '', onError: () => {} })
  const [revision, setRevision] = useState(0)
  if (!discovery.data || (name && !shown.data))
    return (
      <>
        <DialogTitle className="sr-only">Agent definition</DialogTitle>
        <DialogDescription className="sr-only">Loading the definition</DialogDescription>
        <p className="m-auto font-mono text-[12px] text-muted-foreground">
          {shown.error ? errorMessage(shown.error) : 'Loading…'}
        </p>
      </>
    )
  return (
    <Form
      close={close}
      discovery={discovery.data}
      key={revision}
      onChanged={async (saved) => {
        if (saved && saved !== name) return show(saved)
        if (saved === undefined && !name) return close()
        const [next] = await Promise.all([name ? shown.refetch() : undefined, discovery.refetch()])
        if (name && !next) return close()
        setRevision((value) => value + 1)
      }}
      shown={name ? shown.data : undefined}
    />
  )
}

interface Draft {
  name: string
  description: string
  model: ModelRef | null
  thinking: string | null
  /** The family it names; unused while it pins `model`. */
  family: string | null
  tools: string[] | null
  /** Kept as read: the form has no control for it, and a save must not drop it. */
  denyTools: string[]
  resident: boolean
  isolate: 'none' | 'worktree'
  fast: boolean
  summaries: boolean
  instructions: string
}
const draftOf = (definition?: Shown['definition'], name = ''): Draft => ({
  name: definition?.name ?? name,
  description: definition?.description ?? '',
  model: definition?.model ?? null,
  thinking: definition?.thinking ?? null,
  family: definition?.family ?? null,
  tools: definition?.tools ?? null,
  denyTools: definition?.denyTools ?? [],
  resident: definition?.resident ?? false,
  isolate: definition?.isolate ?? 'none',
  fast: definition?.fast ?? false,
  summaries: definition?.summaries ?? true,
  instructions: definition?.instructions ?? '',
})

/** One definition's config; a new one when `shown` is undefined or after Duplicate. */
function Form({
  discovery,
  shown,
  close,
  onChanged,
}: {
  discovery: Discovery
  shown?: Shown
  close: () => void
  /** After a save (the saved name) or a delete (undefined). */
  onChanged: (saved?: string) => Promise<unknown>
}) {
  const system = useSystem()
  const initial = draftOf(shown?.definition, shown?.invalid?.name)
  const [draft, setDraft] = useState(initial)
  // A new definition: blank, duplicated, or replacing a file that fails to parse with nothing else applying.
  const [creating, setCreating] = useState(!shown?.definition)
  const source = creating ? undefined : shown?.source
  const overlays = creating ? [] : (shown?.definition?.overlays ?? [])
  const overlayScope = overlays.at(-1)?.startsWith(`${discovery.scopes.project}/`)
    ? 'project'
    : overlays.length
      ? 'user'
      : undefined
  const [scope, setScope] = useState<Scope>(
    overlayScope ??
      (source === 'user' || (source !== 'project' && discovery.projectSetup !== 'trusted')
        ? 'user'
        : 'project'),
  )
  const [pending, setPending] = useState<'save' | 'delete'>()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string>()
  const models = useModels()
  const { openPanel } = useUltimate()
  const families = useFamilies()
  const [pinning, setPinning] = useState(!!draft.model)
  const familyOf = (name: string | null) =>
    families?.families.find((family) => family.name === (name ?? 'default'))
  const familyRef = (name: string | null) => {
    const model = familyOf(name)?.model
    const slash = model?.indexOf('/') ?? -1
    return model ? { provider: model.slice(0, slash), modelId: model.slice(slash + 1) } : undefined
  }
  const familyModel = familyRef(draft.family) ?? discovery.main.model
  const levelsOf = (model: ModelRef | undefined) => thinkingLevels(models, model)
  const levels = levelsOf(draft.model ?? familyModel)
  const set = (change: Partial<Draft>) => {
    setDraft((previous) => ({ ...previous, ...change }))
    setError(undefined)
  }

  const taken =
    creating && discovery.definitions.some((definition) => definition.name === draft.name)
  const nameError = !creating
    ? undefined
    : !draft.name
      ? undefined
      : !/^[a-zA-Z0-9_-]+$/.test(draft.name)
        ? 'Letters, digits, - and _ only'
        : taken
          ? `${draft.name} exists already: open it to change it`
          : undefined
  const target = `${discovery.scopes[scope]}/${draft.name || '<name>'}.md`
  const display = (path: string) =>
    shortenPath(path, { cwd: system?.project.root, home: system?.machine.home })
  const files = creating ? [] : (shown?.files ?? [])
  const overrides =
    files.includes('builtin') && scope !== 'user' && !overlays.length ? 'the built-in' : undefined
  const shadowed = scope === 'user' && files.includes('project')
  // Saving to a scope without the file, or over one that fails to parse, changes something too.
  const dirty =
    creating ||
    JSON.stringify(draft) !== JSON.stringify(initial) ||
    !files.includes(scope) ||
    shown?.invalid?.source === scope
  const removable = source === 'user' || source === 'project' ? source : undefined
  // What applies once the file Delete removes is gone.
  const fallback = removable && files.filter((file) => file !== removable).at(-1)

  async function save() {
    setPending('save')
    setError(undefined)
    try {
      await api.action(SaveDefinitionAction, {
        name: draft.name,
        scope,
        ...(creating ? { create: true } : {}),
        frontmatter: fieldsOf(draft),
        instructions: draft.instructions,
      })
      await refreshFamilies()
      await onChanged(draft.name)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setPending(undefined)
    }
  }
  async function remove(file: Scope) {
    setPending('delete')
    setConfirming(false)
    try {
      await api.action(DeleteDefinitionAction, { name: draft.name, scope: file })
      await onChanged()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setPending(undefined)
    }
  }

  return (
    <>
      <header className="flex items-start gap-3 border-b border-border/70 px-5 py-3.5">
        <BotIcon className="mt-0.5 size-4.5 shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <DialogTitle className="flex items-center gap-2 font-mono text-[14px] font-medium">
            {creating ? (draft.name ? draft.name : 'New definition') : draft.name}
            {source && <Tag>{sourceLabel[source]}</Tag>}
            {creating && <Tag className="border-brand/40 text-brand">new</Tag>}
          </DialogTitle>
          <DialogDescription className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {shown && !creating
              ? display(shown.path)
              : 'A profile subagents and automations run with: model, thinking, tools, isolate, and instructions.'}
          </DialogDescription>
        </div>
        {shown?.definition && !creating && (
          <Button
            className="h-7 gap-1.5 px-2 font-mono text-[11.5px]"
            onClick={() => {
              setCreating(true)
              set({ name: `${draft.name}-copy` })
              if (discovery.projectSetup !== 'trusted') setScope('user')
            }}
            size="sm"
            title="Start a new definition from this one"
            variant="ghost"
          >
            <CopyIcon className="size-3.5" />
            Duplicate
          </Button>
        )}
        <Button
          aria-label="Close"
          className="size-7"
          onClick={close}
          size="icon-sm"
          variant="ghost"
        >
          <XIcon className="size-4" />
        </Button>
      </header>
      {shown?.invalid && (
        <div className="flex items-start gap-2 border-b border-error/30 bg-error/8 px-5 py-2 text-[12px] text-error">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <p className="min-w-0 leading-snug">
            <span className="font-mono">{display(shown.invalid.path)}</span> fails to parse:{' '}
            <span className="font-mono">{parseError(shown.invalid.error)}</span>.
            {shown.definition
              ? ` The ${sourceLabel[shown.source]} definition applies instead.`
              : ' Saving replaces it.'}
          </p>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5 md:flex-row md:overflow-hidden">
        <div className="flex shrink-0 flex-col gap-4 md:w-[24rem] md:overflow-y-auto md:pr-1">
          {creating && (
            <Field
              hint={nameError ? undefined : 'The name start and automations use.'}
              label="Name"
            >
              <input
                aria-invalid={nameError ? true : undefined}
                aria-label="Name"
                autoFocus
                className={cn(inputClass, 'font-mono')}
                onChange={(event) => set({ name: event.target.value.trim() })}
                placeholder="reviewer-security"
                spellCheck={false}
                value={draft.name}
              />
              {nameError && <p className="text-[11.5px] text-error">{nameError}</p>}
            </Field>
          )}
          <Field label="Description">
            <textarea
              aria-label="Description"
              className={cn(inputClass, 'resize-none leading-snug')}
              onChange={(event) => set({ description: event.target.value })}
              placeholder="What it is for; the coordinator picks by this line."
              rows={2}
              value={draft.description}
            />
          </Field>
          <Field
            hint={
              pinning ? (
                <>
                  Runs on this model, whatever its family runs.{' '}
                  <button
                    className="cursor-pointer text-foreground hover:underline"
                    onClick={() => {
                      setPinning(false)
                      set({ model: null, family: draft.family ?? 'default' })
                    }}
                    type="button"
                  >
                    Use its family
                  </button>
                </>
              ) : (
                <>
                  Families and who runs on each are set in the{' '}
                  <button
                    className="cursor-pointer text-foreground hover:underline"
                    onClick={() => openPanel(agentsPanel)}
                    type="button"
                  >
                    Agents panel
                  </button>
                  .{' '}
                  <button
                    className="cursor-pointer text-foreground hover:underline"
                    onClick={() => setPinning(true)}
                    type="button"
                  >
                    Pin a model
                  </button>{' '}
                  instead.
                </>
              )
            }
            label="Model"
          >
            {!pinning && (
              <div className={cn(inputClass, 'flex items-center font-mono text-[12px]')}>
                <FamilyLabel family={draft.family ?? 'default'} />
              </div>
            )}
            {pinning && (
              <ModelField
                inherited={familyModel}
                onChange={(model) => {
                  // A level the new model lacks would be clamped at start; inherit instead.
                  const unsupported =
                    draft.thinking && !levelsOf(model ?? familyModel).includes(draft.thinking)
                  set({ model, ...(unsupported ? { thinking: null } : {}) })
                }}
                value={draft.model}
              />
            )}
          </Field>
          <Field
            hint={
              draft.thinking
                ? undefined
                : !pinning && familyOf(draft.family)?.thinking
                  ? `Inherits its family's (${familyOf(draft.family)?.thinking}), within what the model supports.`
                  : `Inherits the main conversation's${discovery.main.thinking ? ` (${discovery.main.thinking})` : ''}, within what the model supports.`
            }
            label="Thinking"
          >
            <Segmented
              label="Thinking"
              onChange={(value) => set({ thinking: value === 'inherit' ? null : value })}
              options={[
                { value: 'inherit', label: 'inherit' },
                ...levels.map((level) => ({ value: level, label: level })),
              ]}
              value={draft.thinking ?? 'inherit'}
            />
          </Field>
          <StandingField value={draft.resident} onChange={(resident) => set({ resident })} />
          <SummariesField value={draft.summaries} onChange={(summaries) => set({ summaries })} />
          <Field
            hint={
              draft.isolate === 'worktree'
                ? 'Works on its own branch in a git worktree; land brings its commits back.'
                : 'Works in the parent checkout. A start may still ask for a worktree.'
            }
            label="Isolate"
          >
            <Segmented
              label="Isolate"
              onChange={(isolate) => set({ isolate })}
              options={[
                { value: 'none', label: 'none' },
                { value: 'worktree', label: 'worktree' },
              ]}
              value={draft.isolate}
            />
          </Field>
          <ToolsField
            onChange={(tools) => set({ tools })}
            tools={discovery.main.tools}
            value={draft.tools}
          />
        </div>
        <div className="flex min-h-[20rem] min-w-0 flex-1 flex-col gap-1.5">
          <div className="section-label">Instructions</div>
          <InstructionsEditor
            file={shown && (!creating || !shown.definition) ? shown.raw : undefined}
            onChange={(instructions) => set({ instructions })}
            value={draft.instructions}
          />
        </div>
      </div>
      <footer className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/70 px-5 py-3">
        <span className="section-label">Save to</span>
        <div className="w-36">
          <Segmented
            label="Save to"
            onChange={(next) => {
              if (next === 'project' && discovery.projectSetup !== 'trusted') return
              setScope(next)
            }}
            options={[
              {
                value: 'project',
                label: 'project',
                title:
                  discovery.projectSetup === 'trusted'
                    ? "This project's .ultimate/agents, shared with its team"
                    : "Choose this project's local setup first (Extensions panel)",
              },
              { value: 'user', label: 'user', title: 'Your ~/.ultimate/agents, in every project' },
            ]}
            value={scope}
          />
        </div>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
          title={target}
        >
          {display(target)}
          {overrides && <span className="text-muted-foreground"> · overrides {overrides}</span>}
          {overlays.length > 0 && (
            <span className="text-muted-foreground">
              {' '}
              · an overlay: only the changes, over {display(shown?.path ?? '')}
            </span>
          )}
          {shadowed && (
            <span className="text-warning"> · the project definition of this name applies</span>
          )}
        </span>
        {removable &&
          (confirming ? (
            <span className="flex items-center gap-1 text-[12px]">
              {fallback
                ? `Delete it? The ${sourceLabel[fallback]} one applies again.`
                : 'Delete it?'}
              <Button
                className="h-7 px-2 text-error hover:bg-error/10 hover:text-error"
                onClick={() => void remove(removable)}
                size="sm"
                variant="ghost"
              >
                Delete
              </Button>
              <Button
                className="h-7 px-2"
                onClick={() => setConfirming(false)}
                size="sm"
                variant="ghost"
              >
                Keep
              </Button>
            </span>
          ) : (
            <Button
              className="h-7 gap-1.5 px-2 text-[12px] text-muted-foreground hover:text-error"
              disabled={pending !== undefined}
              onClick={() => setConfirming(true)}
              size="sm"
              title={`Delete ${display(shown!.path)}`}
              variant="ghost"
            >
              <Trash2Icon className="size-3.5" />
              {fallback ? `Revert to ${sourceLabel[fallback]}` : 'Delete'}
            </Button>
          ))}
        <Button className="h-7 px-3 text-[12px]" onClick={close} size="sm" variant="ghost">
          Cancel
        </Button>
        <Button
          className="h-7 px-3 text-[12px]"
          disabled={!dirty || !draft.name || nameError !== undefined || pending !== undefined}
          onClick={() => void save()}
          size="sm"
        >
          {pending === 'save' ? 'Saving…' : 'Save'}
        </Button>
        {error && (
          <p className="basis-full font-mono text-[11.5px] leading-snug break-words text-error">
            {error}
          </p>
        )}
      </footer>
    </>
  )
}
