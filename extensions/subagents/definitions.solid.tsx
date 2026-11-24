import { Bot, Copy, Trash2, TriangleAlert, X } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { createMemo, createSignal, createStore, Show, untrack } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog.solid.tsx'
import { Form } from '@/components/ui/form.solid.tsx'
import { Input, Textarea } from '@/components/ui/input.solid.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.solid.tsx'
import {
  api,
  cn,
  errorMessage,
  events,
  keepLast,
  openPanel,
  shortenPath,
  ROOT,
  useAction,
  useDialog,
  useEvent,
  useExtensionUiState,
  useModels,
  useSystem,
  writerNow,
  writingAs,
} from '@/sdk/solid'
import { DEFAULT_FAMILY } from '../../lib/families.ts'
import {
  agentsPanel,
  FamilyLabel,
  ModelSelect,
  refreshFamilies,
  useFamilies,
} from '../models/ui.solid.tsx'
import {
  Field,
  inputClass,
  InstructionsEditor,
  ResourcesField,
  Segmented,
  thinkingLevels,
  ToggleField,
} from './fields.solid.tsx'
import {
  DefinitionAction,
  DefinitionsAction,
  DeleteDefinitionAction,
  SaveDefinitionAction,
} from './refs.ts'
import type { DefinitionFields, Discovery, ModelRef, Scope, Shown, Source } from './refs.ts'

export const definitionDialog = 'subagents.definition'
const shownKey = 'definition'
const sourceLabel: Record<Source, string> = {
  builtin: 'built-in',
  user: 'user',
  project: 'project',
}
export const parseError = (error: string) => error.replace(/^Error: /, '')

export function Tag(props: { children: JSX.Element; class?: string }) {
  return (
    <span
      class={cn(
        'shrink-0 rounded-sm border border-border/80 px-1 text-[10px] leading-4 text-muted-foreground',
        props.class,
      )}
    >
      {props.children}
    </span>
  )
}

export function useOpenDefinition() {
  const [, setShown] = useExtensionUiState(shownKey, '')
  const [, setOpen] = useDialog(definitionDialog)
  return (name: string) => {
    setShown(name)
    setOpen(true)
  }
}

interface Draft {
  name: string
  description: string
  model: ModelRef | null
  thinking: string | null
  family: string | null
  tools: string[] | null
  preservedDenyTools: string[]
  skills: string[] | null
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
  tools: definition?.tools?.filter((tool) => !definition.denyTools?.includes(tool)) ?? null,
  preservedDenyTools: definition?.denyTools ?? [],
  skills: definition?.skills ?? null,
  resident: definition?.resident ?? false,
  isolate: definition?.isolate ?? 'none',
  fast: definition?.fast ?? false,
  summaries: definition?.summaries ?? true,
  instructions: definition?.instructions ?? '',
})

const modelKey = (model: ModelRef | null | undefined) =>
  model ? `${model.provider}/${model.modelId}` : undefined
const modelRef = (key: string | undefined) => {
  if (!key) return undefined
  const slash = key.indexOf('/')
  return { provider: key.slice(0, slash), modelId: key.slice(slash + 1) }
}
const frontmatterOf = (draft: Draft): DefinitionFields => {
  const denyTools = draft.preservedDenyTools.filter((tool) => !draft.tools?.includes(tool))
  return {
    description: draft.description,
    ...(draft.model ? { model: modelKey(draft.model) } : {}),
    ...(draft.thinking ? { thinking: draft.thinking } : {}),
    ...(!draft.model && draft.family ? { family: draft.family } : {}),
    ...(draft.tools ? { tools: [...draft.tools] } : {}),
    ...(denyTools.length ? { denyTools } : {}),
    ...(draft.skills ? { skills: [...draft.skills] } : {}),
    resident: draft.resident,
    ...(draft.isolate === 'worktree' ? { isolate: 'worktree' } : {}),
    ...(draft.fast ? { fast: true } : {}),
    ...(draft.summaries ? {} : { summaries: false }),
  }
}

function overlayScope(overlays: string[] | undefined, discovery: Discovery): Scope | undefined {
  if (!overlays?.length) return undefined
  return overlays.at(-1)?.startsWith(`${discovery.scopes.project}/`) ? 'project' : 'user'
}

export async function moveDefinition(name: string, family: string, discovery: Discovery) {
  const writer = writerNow()
  const shown = await api.action(DefinitionAction, { name })
  if (!shown.definition) throw new Error(`${name} fails to parse: open it to fix it`)
  const scope =
    overlayScope(shown.definition.overlays, discovery) ??
    (shown.source === 'builtin'
      ? discovery.projectSetup === 'trusted'
        ? 'project'
        : 'user'
      : shown.source)
  const draft = { ...draftOf(shown.definition), family, model: null }
  await writingAs(writer, () =>
    api.action(SaveDefinitionAction, {
      name,
      scope,
      frontmatter: frontmatterOf(draft),
      instructions: draft.instructions,
      overlay: true,
    }),
  )
  await refreshFamilies()
  return `${discovery.scopes[scope]}/${name}.md`
}

export function DefinitionDialog() {
  const [open, setOpen] = useDialog(definitionDialog)
  const [shown, setShown] = useExtensionUiState(shownKey, '')
  const editing = createMemo(() => (open() ? { name: shown() } : undefined))
  const show = useOpenDefinition()
  useEvent('subagents:open-definition', (data) => {
    const name = (data as { name?: unknown } | undefined)?.name
    if (typeof name === 'string') show(name)
  })
  return (
    <Dialog
      open={open()}
      onOpenChange={setOpen}
      onOpenChangeComplete={(opened) => {
        if (!opened) events.emit('subagents:definition-closed', { name: shown() })
      }}
    >
      <DialogContent
        class="flex h-[min(88vh,52rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
        showCloseButton={false}
      >
        <Show when={editing()} keyed>
          {({ name }) => (
            <DefinitionLoader close={() => setOpen(false)} name={name} show={setShown} />
          )}
        </Show>
      </DialogContent>
    </Dialog>
  )
}

function DefinitionLoader(props: {
  name: string
  show: (name: string) => void
  close: () => void
}) {
  const name = untrack(() => props.name)
  const shown = name
    ? useAction(DefinitionAction, { name }, { conversation: ROOT, onError: keepLast })
    : undefined
  const discovery = useAction(DefinitionsAction, null, { conversation: ROOT })
  const [revision, revise] = createSignal(1)
  async function changed(saved?: string) {
    const { close, show } = props
    if (saved && saved !== name) return show(saved)
    if (!name) return close()
    const source = writerNow()
    const [next] = await Promise.all([shown?.refetch(), discovery.refetch()])
    if (!next) return writingAs(source, close)
    revise((value) => value + 1)
    return undefined
  }
  return (
    <Show
      when={discovery.data() && (!shown || shown.data())}
      fallback={
        <>
          <DialogTitle class="sr-only">Agent definition</DialogTitle>
          <DialogDescription class="sr-only">Loading the definition</DialogDescription>
          <p class="m-auto font-mono text-[12px] text-muted-foreground">
            {shown?.error() ? errorMessage(shown.error()) : 'Loading…'}
          </p>
        </>
      }
    >
      <Show when={revision()} keyed>
        {(_revision) => (
          <DefinitionForm
            close={props.close}
            discovery={discovery.data()!}
            onChanged={changed}
            shown={shown?.data()}
          />
        )}
      </Show>
    </Show>
  )
}

function DefinitionForm(props: {
  discovery: Discovery
  shown?: Shown
  close: () => void
  onChanged: (saved?: string) => Promise<void>
}) {
  const system = useSystem()
  const models = useModels()
  const families = useFamilies()
  const initial = untrack(() => draftOf(props.shown?.definition, props.shown?.invalid?.name))
  const [draft, setDraft] = createStore({ ...initial })
  const [creating, setCreating] = createSignal(!untrack(() => props.shown?.definition))
  const source = () => (creating() ? undefined : props.shown?.source)
  const overlays = () => (creating() ? [] : (props.shown?.definition?.overlays ?? []))
  const [scope, setScope] = createSignal<Scope>(
    untrack(
      () =>
        overlayScope(overlays(), props.discovery) ??
        (source() === 'user' ||
        (source() !== 'project' && props.discovery.projectSetup !== 'trusted')
          ? 'user'
          : 'project'),
    ),
  )
  const [pending, setPending] = createSignal<'save' | 'delete'>()
  const [confirming, setConfirming] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [pinning, setPinning] = createSignal(!!initial.model)
  const family = createMemo(() =>
    families()?.families.find((item) => item.name === (draft.family ?? DEFAULT_FAMILY)),
  )
  const familyModel = () => modelRef(family()?.model) ?? props.discovery.main.model
  const levelsOf = (model: ModelRef | undefined) => thinkingLevels(models(), model)
  const levels = createMemo(() => levelsOf(draft.model ?? familyModel()))
  const set = (change: Partial<Draft>) => {
    setDraft((previous) => {
      Object.assign(previous, change)
    })
    setError(undefined)
  }
  const name = () => draft.name.trim()
  const nameError = () => {
    if (!creating() || !name()) return undefined
    if (!/^[a-zA-Z0-9_-]+$/.test(name())) return 'Letters, digits, - and _ only'
    if (props.discovery.definitions.some((item) => item.name === name()))
      return `${name()} exists already: open it to change it`
    return undefined
  }
  const target = () => `${props.discovery.scopes[scope()]}/${name() || '<name>'}.md`
  const display = (path: string) =>
    shortenPath(path, { cwd: system()?.project.root, home: system()?.machine.home })
  const files = () => (creating() ? [] : (props.shown?.files ?? []))
  const overrides = () => files().includes('builtin') && scope() !== 'user' && !overlays().length
  const shadowedOverlay = () =>
    scope() === 'user' &&
    (overlayScope(overlays(), props.discovery) === 'project' ||
      (overlays().length > 0 && source() === 'project'))
  const shadowed = () => scope() === 'user' && files().includes('project')
  const needsSave = createMemo(
    () =>
      creating() ||
      JSON.stringify(draft) !== JSON.stringify(initial) ||
      !files().includes(scope()) ||
      props.shown?.invalid?.source === scope(),
  )
  const removable = () => {
    const current = source()
    return current === 'user' || current === 'project' ? current : undefined
  }
  const afterDeletion = () =>
    files()
      .filter((file) => file !== removable())
      .at(-1)
  const afterDeletionLabel = () => {
    const next = afterDeletion()
    return next && sourceLabel[next]
  }
  const canSave = () => needsSave() && !!name() && !nameError() && !pending() && !shadowedOverlay()

  async function save(writer: string) {
    if (!canSave()) return
    const saved = name()
    const changed = props.onChanged
    setPending('save')
    setError(undefined)
    try {
      await api.action(SaveDefinitionAction, {
        name: saved,
        scope: scope(),
        ...(creating() ? { create: true } : {}),
        frontmatter: frontmatterOf(draft),
        instructions: draft.instructions,
      })
      await refreshFamilies()
      await writingAs(writer, () => changed(saved))
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setPending(undefined)
    }
  }

  async function remove(file: Scope, writer: string) {
    if (pending()) return
    const changed = props.onChanged
    setPending('delete')
    setConfirming(false)
    try {
      await api.action(DeleteDefinitionAction, { name: name(), scope: file })
      await writingAs(writer, () => changed())
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setPending(undefined)
    }
  }

  return (
    <Form class="flex min-h-0 flex-1 flex-col">
      <header class="flex items-start gap-3 border-b border-border/70 px-5 py-3.5">
        <Bot class="mt-0.5 size-4.5 shrink-0 text-brand" />
        <div class="min-w-0 flex-1">
          <DialogTitle class="flex items-center gap-2 font-mono text-[14px] font-medium">
            {name() || 'New definition'}
            <Show when={source()}>{(value) => <Tag>{sourceLabel[value()]}</Tag>}</Show>
            <Show when={creating()}>
              <Tag class="border-brand/40 text-brand">new</Tag>
            </Show>
          </DialogTitle>
          <DialogDescription class="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {props.shown && !creating()
              ? display(props.shown.path)
              : 'A profile subagents and automations run with: model, thinking, tools, isolate, and instructions.'}
          </DialogDescription>
        </div>
        <Show when={props.shown?.definition && !creating()}>
          <Button
            aria-label="Duplicate this definition"
            class="h-7 gap-1.5 px-2 font-mono text-[11.5px]"
            onClick={() => {
              setCreating(true)
              set({ name: `${name()}-copy` })
              if (props.discovery.projectSetup !== 'trusted') setScope('user')
            }}
            size="sm"
            title="Start a new definition from this one"
            variant="ghost"
          >
            <Copy class="size-3.5" /> Duplicate
          </Button>
        </Show>
        <Button
          aria-label="Close definition editor"
          class="size-7"
          onClick={() => props.close()}
          size="icon-sm"
          variant="ghost"
        >
          <X class="size-4" />
        </Button>
      </header>
      <Show when={props.shown?.invalid}>
        {(invalid) => (
          <div class="flex items-start gap-2 border-b border-error/30 bg-error/8 px-5 py-2 text-[12px] text-error">
            <TriangleAlert class="mt-0.5 size-3.5 shrink-0" />
            <p class="min-w-0 leading-snug">
              <span class="font-mono">{display(invalid().path)}</span> fails to parse:{' '}
              <span class="font-mono">{parseError(invalid().error)}</span>.
              {props.shown?.definition
                ? ` The ${sourceLabel[props.shown.source]} definition applies instead.`
                : ' Saving replaces it.'}
            </p>
          </div>
        )}
      </Show>
      <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5 md:flex-row md:overflow-hidden">
        <div class="flex shrink-0 flex-col gap-4 md:w-[24rem] md:overflow-y-auto md:pr-1">
          <Show when={creating()}>
            <Field
              hint={nameError() ? undefined : 'The name start and automations use.'}
              label="Name"
            >
              <Input
                aria-invalid={nameError() ? 'true' : undefined}
                aria-label="Definition identifier"
                autofocus
                class={cn(inputClass, 'h-auto font-mono')}
                onValueChange={(value) => set({ name: value })}
                placeholder="reviewer-security"
                value={draft.name}
              />
              <Show when={nameError()}>
                <p class="text-[11.5px] text-error">{nameError()}</p>
              </Show>
            </Field>
          </Show>
          <Field label="Description">
            <Textarea
              aria-label="Description"
              class={cn(inputClass, 'resize-none py-1.5 leading-snug')}
              onValueChange={(value) => set({ description: value })}
              placeholder="What it is for; the coordinator picks by this line."
              rows={2}
              value={draft.description}
            />
          </Field>
          <Field
            label="Model"
            hint={
              <Show
                when={pinning()}
                fallback={
                  <>
                    Families and who runs on each are set in the{' '}
                    <TextButton onClick={() => openPanel(agentsPanel)}>Agents panel</TextButton>.{' '}
                    <TextButton onClick={() => setPinning(true)}>Pin a model</TextButton> instead.
                  </>
                }
              >
                Runs on this model, whatever its family runs.{' '}
                <TextButton
                  onClick={() => {
                    setPinning(false)
                    set({ model: null, family: draft.family ?? DEFAULT_FAMILY })
                  }}
                >
                  Use its family
                </TextButton>
              </Show>
            }
          >
            <Show
              when={pinning()}
              fallback={
                <div class={cn(inputClass, 'flex items-center font-mono text-[12px]')}>
                  <FamilyLabel family={draft.family ?? DEFAULT_FAMILY} />
                </div>
              }
            >
              <ModelSelect
                class={cn(inputClass, 'text-[12px]')}
                compact
                inherit={
                  familyModel() ? `inherit · ${familyModel()?.modelId}` : 'inherit · its model'
                }
                name="agent definition"
                onChange={(value) => {
                  const model = modelRef(value) ?? null
                  const unsupportedThinking =
                    draft.thinking && !levelsOf(model ?? familyModel()).includes(draft.thinking)
                  set({ model, ...(unsupportedThinking ? { thinking: null } : {}) })
                }}
                placeholder={familyModel() ? `inherit · ${familyModel()?.modelId}` : 'inherit'}
                value={modelKey(draft.model)}
              />
            </Show>
          </Field>
          <Field
            label="Thinking"
            hint={
              draft.thinking
                ? undefined
                : !pinning() && family()?.thinking
                  ? `Inherits its family's (${family()?.thinking}), within what the model supports.`
                  : `Inherits the main conversation's${props.discovery.main.thinking ? ` (${props.discovery.main.thinking})` : ''}, within what the model supports.`
            }
          >
            <Segmented
              label="Thinking"
              onChange={(value) => set({ thinking: value === 'inherit' ? null : value })}
              options={['inherit', ...levels()].map((value) => ({ value }))}
              value={draft.thinking ?? 'inherit'}
            />
          </Field>
          <ToggleField
            label="Standing agent"
            text="Available by name"
            hint="One conversation per project, addressed by @name. Its isolate setting is ignored."
            value={draft.resident}
            onChange={(resident) => set({ resident })}
          />
          <ToggleField
            label="Automatic summaries"
            text="Title and reply activity"
            hint={
              draft.summaries
                ? 'The summary model names its conversations and describes each reply for the sidebar.'
                : 'Its conversations keep the title they were given; the summary model answers only explicit calls.'
            }
            value={draft.summaries}
            onChange={(summaries) => set({ summaries })}
          />
          <Field
            label="Isolate"
            hint={
              draft.isolate === 'worktree'
                ? 'Works on its own branch in a git worktree; land brings its commits back.'
                : 'Works in the parent checkout. A start may still ask for a worktree.'
            }
          >
            <Segmented
              label="Isolate"
              onChange={(isolate) => set({ isolate })}
              options={[{ value: 'none' }, { value: 'worktree' }]}
              value={draft.isolate}
            />
          </Field>
          <ResourcesField
            kind="tool"
            onChange={(tools) => set({ tools })}
            resources={props.discovery.main.tools}
            value={draft.tools}
          />
          <ResourcesField
            kind="skill"
            onChange={(skills) => set({ skills })}
            resources={props.discovery.skills}
            value={draft.skills}
          />
        </div>
        <div class="flex min-h-[20rem] min-w-0 flex-1 flex-col gap-1.5">
          <div class="section-label">Instructions</div>
          <Show when={overlays().length > 0 && !shadowedOverlay()}>
            <p class="text-[11.5px] text-muted-foreground">
              Edit the {scope()} additions or append new instructions. Leave inherited text
              unchanged.
            </p>
          </Show>
          <InstructionsEditor
            file={!creating() || !props.shown?.definition ? props.shown?.raw : undefined}
            onChange={(instructions) => set({ instructions })}
            value={draft.instructions}
          />
        </div>
      </div>
      <footer class="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/70 px-5 py-3">
        <span class="section-label">Save to</span>
        <div class="w-36">
          <Segmented
            label="Destination scope"
            onChange={setScope}
            options={[
              {
                value: 'project',
                disabled: props.discovery.projectSetup !== 'trusted',
                title:
                  props.discovery.projectSetup === 'trusted'
                    ? "This project's .ultimate/agents, shared with its team"
                    : "Choose this project's local setup first (Extensions panel)",
              },
              { value: 'user', title: 'Your ~/.ultimate/agents, in every project' },
            ]}
            value={scope()}
          />
        </div>
        <Tooltip type="description">
          <TooltipTrigger
            aria-label="Definition file path"
            class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
            render={(trigger) => <span {...trigger} />}
          >
            {display(target())}
            <Show when={overrides()}>
              <span class="text-muted-foreground/70"> · overrides the built-in</span>
            </Show>
            <Show when={overlays().length > 0}>
              <span class="text-muted-foreground/70">
                {' '}
                · an overlay: only the changes, over {display(props.shown?.path ?? '')}
              </span>
            </Show>
            <Show when={shadowed()}>
              <span class="text-warning">
                {' '}
                {shadowedOverlay()
                  ? '· this overlay must be saved to project'
                  : '· the project definition of this name applies'}
              </span>
            </Show>
          </TooltipTrigger>
          <TooltipContent class="font-mono">{target()}</TooltipContent>
        </Tooltip>
        <Show when={removable()}>
          {(file) => (
            <Show
              when={confirming()}
              fallback={
                <Button
                  aria-label="Review deletion of definition"
                  class="h-7 gap-1.5 px-2 text-[12px] text-muted-foreground hover:text-error"
                  disabled={!!pending()}
                  onClick={() => setConfirming(true)}
                  size="sm"
                  title={`Delete ${display(props.shown!.path)}`}
                  variant="ghost"
                >
                  <Trash2 class="size-3.5" />
                  {afterDeletionLabel() ? `Revert to ${afterDeletionLabel()}` : 'Delete'}
                </Button>
              }
            >
              <span class="flex items-center gap-1 text-[12px]">
                {afterDeletionLabel()
                  ? `Delete it? The ${afterDeletionLabel()} one applies again.`
                  : 'Delete it?'}
                <Button
                  aria-label="Confirm file deletion"
                  class="h-7 px-2 text-error hover:bg-error/10 hover:text-error"
                  data-agent-confirm={`Delete the ${file()} definition for ${name()}?`}
                  onClick={(_, details) => remove(file(), details.source)}
                  size="sm"
                  variant="ghost"
                >
                  Delete
                </Button>
                <Button
                  aria-label="Keep definition file"
                  class="h-7 px-2"
                  onClick={() => setConfirming(false)}
                  size="sm"
                  variant="ghost"
                >
                  Keep
                </Button>
              </span>
            </Show>
          )}
        </Show>
        <Button
          aria-label="Cancel definition editing"
          class="h-7 px-3 text-[12px]"
          onClick={() => props.close()}
          size="sm"
          variant="ghost"
        >
          Cancel
        </Button>
        <Button
          aria-label="Save agent definition"
          class="h-7 px-3 text-[12px]"
          disabled={!canSave()}
          onClick={(_, details) => save(details.source)}
          size="sm"
          type="submit"
        >
          {pending() === 'save' ? 'Saving…' : 'Save'}
        </Button>
        <Show when={error()}>
          <p class="basis-full font-mono text-[11.5px] leading-snug break-words text-error">
            {error()}
          </p>
        </Show>
      </footer>
    </Form>
  )
}

function TextButton(props: { onClick: () => void; children: string }) {
  return (
    <Button
      class="inline h-auto text-left text-[11.5px] font-normal text-foreground hover:underline"
      onClick={() => props.onClick()}
      size={null}
      variant={null}
    >
      {props.children}
    </Button>
  )
}
