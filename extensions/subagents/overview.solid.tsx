import { Bot, Check, Pin, Plus, Sparkles } from '@lucide/solid'
import { Dynamic } from '@solidjs/web'
import type { JSX } from '@solidjs/web'
import { createMemo, createSignal, For, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.solid.tsx'
import {
  ROOT,
  cn,
  errorMessage,
  notify,
  shortenPath,
  useAction,
  useDialog,
  useSystem,
} from '@/sdk/solid'
import { DEFAULT_FAMILY, familyColor, familyTitle } from '../../lib/families.shared.ts'
import {
  AddFamily,
  FamilyDot,
  FamilyPopover,
  modelIdOf,
  moveFeature,
  runsOn,
  useFamilies,
} from '../models/ui.solid.tsx'
import type { FamiliesView, FamilyUser, FamilyView } from '../models/refs.ts'
import {
  definitionDialog,
  moveDefinition,
  parseError,
  Tag,
  useOpenDefinition,
} from './definitions.solid.tsx'
import { DefinitionsAction } from './refs.ts'
import type { Definition } from './refs.ts'

export function AgentsPanel() {
  const families = useFamilies()
  const [editing] = useDialog(definitionDialog)
  const system = useSystem()
  const { data, refetch } = useAction(DefinitionsAction, null, {
    conversation: ROOT,
    on: () => [editing(), system()?.code.sha, system()?.project.settings],
    focus: true,
  })
  const show = useOpenDefinition()
  const [wrote, setWrote] = createSignal<string>()
  const definitions = () => data()?.definitions ?? []
  const errors = () => data()?.errors ?? []
  const byFamily = createMemo(() => Map.groupBy(definitions(), (item) => item.runs?.family))
  const featuresByFamily = createMemo(() =>
    Map.groupBy(
      families()?.users.filter((item) => item.kind === 'feature') ?? [],
      (item) => item.family,
    ),
  )

  async function moveAgent(definition: Definition, family: string) {
    const discovery = data()
    if (!discovery) return
    try {
      const path = await moveDefinition(definition.name, family, discovery)
      setWrote(
        `${definition.name} → ${familyTitle(family)} · ${shortenPath(path, { cwd: system()?.project.root, home: system()?.machine.home })}`,
      )
      await refetch()
    } catch (failure) {
      notify({ level: 'error', message: errorMessage(failure) })
    }
  }
  async function moveFeatureTo(id: string, family: string) {
    const view = families()
    if (!view) return
    try {
      await moveFeature(view, id, family)
      setWrote(undefined)
    } catch (failure) {
      notify({ level: 'error', message: errorMessage(failure) })
    }
  }

  return (
    <Show when={data() && families()}>
      {(view) => (
        <div class="py-2" data-agents-overview>
          <div class="flex items-center gap-2 px-3 pb-2 section-label">
            Agents
            <span class="ml-auto flex items-center gap-2 text-muted-foreground/70">
              <span>
                {definitions().length}
                <Show when={errors().length > 0}>
                  <span class="text-error"> · {errors().length} invalid</span>
                </Show>
              </span>
              <AddFamily view={view()} />
              <Button
                aria-label="New agent definition"
                class="h-5 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
                onClick={() => show('')}
                size="xs"
                title="New agent definition"
                variant="ghost"
              >
                <Plus class="size-3" /> Agent
              </Button>
            </span>
          </div>
          <For each={view().errors}>
            {(problem) => (
              <p class="px-3 pb-2 font-mono text-[11px] leading-snug text-error">{problem}</p>
            )}
          </For>
          <Show when={wrote()}>
            {(text) => (
              <p
                class="truncate px-3 pb-2 font-mono text-[10.5px] text-muted-foreground"
                title={text()}
              >
                <span class="text-success">saved</span> {text()}
              </p>
            )}
          </Show>
          <For each={view().families} keyed={(family) => family.name}>
            {(family) => (
              <FamilyGroup
                agents={byFamily().get(family().name) ?? []}
                family={family()}
                features={featuresByFamily().get(family().name) ?? []}
                onMoveAgent={moveAgent}
                onMoveFeature={moveFeatureTo}
                onOpen={show}
                view={view()}
              />
            )}
          </For>
          <Show when={byFamily().has(undefined) || featuresByFamily().has(undefined)}>
            <FamilyGroup
              agents={byFamily().get(undefined) ?? []}
              features={featuresByFamily().get(undefined) ?? []}
              onMoveAgent={moveAgent}
              onMoveFeature={moveFeatureTo}
              onOpen={show}
              view={view()}
            />
          </Show>
          <Show when={errors().length > 0}>
            <section class="pt-3">
              <For each={errors()} keyed={(error) => error.path}>
                {(error) => (
                  <Button
                    aria-label={`Repair ${error().source} ${error().name} definition file`}
                    class="block w-full px-3 py-1 text-left font-normal whitespace-normal transition-colors hover:bg-accent/50"
                    onClick={() => show(error().name)}
                    size={null}
                    title={error().path}
                    variant={null}
                  >
                    <div class="flex min-w-0 items-center gap-1.5 font-mono text-[11.5px] text-error">
                      <Bot class="size-3.5 shrink-0" />
                      <span class="shrink-0">{error().name}</span>
                      <Tag>{error().source}</Tag>
                    </div>
                    <p class="line-clamp-3 pl-5 font-mono text-[11px] leading-snug break-words whitespace-pre-wrap text-error/80">
                      {parseError(error().error)}
                    </p>
                  </Button>
                )}
              </For>
            </section>
          </Show>
          <Show when={!definitions().length && !errors().length}>
            <p class="px-3 pt-3 font-sans text-[12px] leading-relaxed text-muted-foreground/70">
              No definitions yet: add one with Agent, or Markdown files in{' '}
              <code class="font-mono">.ultimate/agents/</code>
            </p>
          </Show>
        </div>
      )}
    </Show>
  )
}

function FamilyGroup(props: {
  family?: FamilyView
  view: FamiliesView
  agents: Definition[]
  features: FamilyUser[]
  onOpen: (name: string) => void
  onMoveAgent: (definition: Definition, to: string) => Promise<void>
  onMoveFeature: (id: string, to: string) => Promise<void>
}) {
  return (
    <section class="pt-3 first-of-type:pt-1">
      <Show
        when={props.family}
        fallback={
          <div class="flex items-center gap-1.5 px-3 pb-0.5 font-mono text-[11.5px] text-muted-foreground">
            <Pin class="size-3" /> Own model
            <span class="text-[10.5px] text-muted-foreground/60">· no family</span>
          </div>
        }
      >
        {(family) => {
          const model = () => runsOn(family())
          const thinking = () => family().thinking ?? family().followsThinking
          return (
            <FamilyPopover
              class="group/family flex w-full min-w-0 items-center gap-1.5 px-3 py-1 text-left font-mono text-[11.5px] transition-colors hover:bg-accent/50 data-open:bg-accent/50"
              family={family()}
              title={`${model() ?? 'No model'}${thinking() ? ` · thinking ${thinking()}` : ''}${family().name === DEFAULT_FAMILY && family().follows ? " (Pi's default)" : ''} · click to change`}
              view={props.view}
            >
              <FamilyDot color={family().color} />
              <span class="shrink-0 font-medium" style={{ color: familyColor(family().color) }}>
                {familyTitle(family().name)}
              </span>
              <span class="min-w-0 truncate text-muted-foreground">
                {model() ? modelIdOf(model()!) : 'no model'}
                <Show when={thinking()}>
                  <span class="text-muted-foreground/70"> · {thinking()}</span>
                </Show>
              </span>
              <span class="ml-auto shrink-0 pl-2 text-[10.5px] text-muted-foreground/60 opacity-0 transition-opacity group-hover/family:opacity-100">
                edit
              </span>
            </FamilyPopover>
          )
        }}
      </Show>
      <div
        class={props.family ? 'ml-[1.0625rem] border-l' : undefined}
        style={{
          'border-color': props.family ? `${familyColor(props.family.color)}40` : undefined,
        }}
      >
        <For each={props.agents} keyed={(definition) => definition.path}>
          {(definition) => (
            <AgentRow
              definition={definition()}
              family={props.family}
              onMove={(to) => props.onMoveAgent(definition(), to)}
              onOpen={() => props.onOpen(definition().name)}
              view={props.view}
            />
          )}
        </For>
        <For each={props.features} keyed={(feature) => feature.id}>
          {(feature) => (
            <Row
              description={feature().description}
              icon={Sparkles}
              label={feature().label}
              meta={!props.family && feature().pinned && modelIdOf(feature().pinned!)}
              move={
                <MoveMenu
                  current={props.family?.name}
                  disabled={!!feature().project}
                  label={feature().label}
                  row="feature"
                  onMove={(to) => props.onMoveFeature(feature().id, to)}
                  view={props.view}
                />
              }
              title={
                feature().project ? "The project's settings decide its family" : feature().pinnedIn
              }
            />
          )}
        </For>
        <Show when={!props.agents.length && !props.features.length}>
          <p class="py-1 pl-2.5 font-mono text-[10.5px] text-muted-foreground/50">
            nothing runs on it
          </p>
        </Show>
      </div>
    </section>
  )
}

function AgentRow(props: {
  definition: Definition
  family?: FamilyView
  view: FamiliesView
  onOpen: () => void
  onMove: (family: string) => Promise<void>
}) {
  const definition = () => props.definition
  const thinking = () => definition().runs?.thinking ?? definition().thinking
  const familyThinking = () => props.family?.thinking ?? props.family?.followsThinking
  return (
    <Row
      description={definition().description}
      icon={Bot}
      label={definition().name}
      meta={
        <>
          {!props.family && definition().model && modelIdOf(`/${definition().model?.modelId}`)}
          <Show when={thinking() && thinking() !== familyThinking()}>
            <span> · {thinking()}</span>
          </Show>
        </>
      }
      move={
        <MoveMenu
          current={props.family?.name}
          label={definition().name}
          row="agent"
          onMove={props.onMove}
          view={props.view}
        />
      }
      onOpen={props.onOpen}
      tags={
        <>
          <Show when={definition().source !== 'builtin'}>
            <Tag>{definition().source}</Tag>
          </Show>
          <Show when={definition().isolate === 'worktree'}>
            <Tag>worktree</Tag>
          </Show>
        </>
      }
      title={[
        definition().path,
        definition().model && `pins ${definition().model?.provider}/${definition().model?.modelId}`,
        `tools: ${definition().tools?.join(', ') ?? 'inherited'}`,
      ]
        .filter(Boolean)
        .join('\n')}
    />
  )
}

function Row(props: {
  icon: typeof Bot
  label: string
  description: string
  tags?: JSX.Element
  meta?: JSX.Element
  move: JSX.Element
  title?: string
  onOpen?: () => void
}) {
  const body = (
    <>
      <div class="flex min-w-0 items-center gap-1.5 font-mono text-[11.5px]">
        <Dynamic component={props.icon} class="size-3 shrink-0 text-muted-foreground/70" />
        <span class="shrink-0 text-foreground/85">{props.label}</span>
        {props.tags}
        <Show when={props.meta}>
          <span class="min-w-0 truncate text-[10.5px] text-muted-foreground/70">{props.meta}</span>
        </Show>
      </div>
      <p class="line-clamp-1 pl-4.5 font-sans text-[11.5px] leading-snug text-muted-foreground/80">
        {props.description}
      </p>
    </>
  )
  return (
    <div
      class="group/row flex min-w-0 items-start transition-colors hover:bg-accent/40"
      title={props.title}
    >
      <Show when={props.onOpen} fallback={<div class="min-w-0 flex-1 py-1 pl-2.5">{body}</div>}>
        {(open) => (
          <Button
            aria-label={`Configure ${props.label} agent definition`}
            class="block min-w-0 flex-1 py-1 pl-2.5 text-left font-normal"
            onClick={() => open()()}
            size={null}
            variant={null}
          >
            {body}
          </Button>
        )}
      </Show>
      <div class="shrink-0 pt-1 pr-2">{props.move}</div>
    </div>
  )
}

function MoveMenu(props: {
  current?: string
  view: FamiliesView
  label: string
  row: 'agent' | 'feature'
  disabled?: boolean
  onMove: (family: string) => Promise<void>
}) {
  const family = () => props.view.families.find((item) => item.name === props.current)
  return (
    <DropdownMenu onAction={(value) => (value === props.current ? undefined : props.onMove(value))}>
      <DropdownMenuTrigger
        aria-label={`Move ${props.row} ${props.label} to another family`}
        class="flex h-5 items-center gap-1 rounded px-1 font-mono text-[10.5px] text-muted-foreground/0 transition-colors group-hover/row:text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:text-muted-foreground disabled:pointer-events-none data-open:bg-accent data-open:text-foreground pointer-coarse:text-muted-foreground"
        disabled={props.disabled}
        title={props.disabled ? "The project's settings decide it" : 'Run it on another family'}
      >
        move
        <Show when={family()} fallback={<Pin class="size-2.5" />}>
          {(item) => <FamilyDot class="size-1.5" color={item().color} />}
        </Show>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="w-64 font-mono">
        <DropdownMenuGroup>
          <DropdownMenuLabel class="section-label">Run {props.label} on</DropdownMenuLabel>
          <For each={props.view.families} keyed={(item) => item.name}>
            {(item) => (
              <DropdownMenuItem
                aria-label={`Assign ${props.row} ${props.label} to the ${familyTitle(item().name)} family`}
                class="gap-2 py-1 text-[12px]"
                value={item().name}
              >
                <Check
                  class={cn('size-3.5', item().name === props.current ? 'text-brand' : 'opacity-0')}
                />
                <FamilyDot color={item().color} />
                <span style={{ color: familyColor(item().color) }}>
                  {familyTitle(item().name)}
                </span>{' '}
                <span class="sr-only">family destination</span>{' '}
                <span
                  aria-hidden="true"
                  class="ml-auto truncate text-[10.5px] text-muted-foreground"
                >
                  {runsOn(item()) ? modelIdOf(runsOn(item())!) : ''}
                </span>
              </DropdownMenuItem>
            )}
          </For>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
