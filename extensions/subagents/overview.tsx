/**
 * The Agents panel: one overview of what runs on which model. Each model family heads a group (its model and thinking;
 * a click edits them in place), and every agent definition and feature on it sits under it. An agent row opens
 * its definition; its dot moves it to another family, which writes the definition (an overlay for a built-in). A
 * feature's dot moves it in the project's families. Agents and features that pin a model of their own come last.
 */
import { BotIcon, CheckIcon, PinIcon, PlusIcon, SparklesIcon } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn, errorMessage, shortenPath, useAction, useDialog, useSystem } from '@/sdk'
import { store } from '@/sdk/client'
import { DEFAULT_FAMILY, familyColor, familyTitle } from '../../lib/families.ts'
import {
  AddFamily,
  FamilyDot,
  FamilyPopover,
  moveFeature,
  runsOn,
  useFamilies,
} from '../models/ui.tsx'
import type { FamiliesView, FamilyView } from '../models/ui.tsx'
import { definitionDialog, moveDefinition, parseError, useOpenDefinition } from './definitions.tsx'
import { Heading, Tag, useRefresh } from './parts.tsx'
import { DefinitionsAction } from './refs.ts'
import type { Definition, Discovery } from './refs.ts'

const short = (ref: string) => ref.slice(ref.indexOf('/') + 1)

export function AgentsOverview() {
  const { data, refetch } = useAction(DefinitionsAction)
  const families = useFamilies()
  const [editing] = useDialog(definitionDialog)
  const system = useSystem()
  // A landing or a settings change broadcasts new system info: definitions may have changed with it.
  useRefresh(refetch, `${editing} ${system?.code.sha} ${JSON.stringify(system?.project.settings)}`)
  const show = useOpenDefinition()
  // What the last move wrote, until the next one.
  const [wrote, setWrote] = useState<string>()
  if (!data || !families) return null
  const { definitions, errors } = data
  const features = families.users.filter((user) => user.kind === 'feature')
  const pinned = definitions.filter((definition) => !definition.runs?.family)
  const pinnedFeatures = features.filter((user) => !user.family)
  const display = (path: string) =>
    shortenPath(path, { cwd: system?.project.root, home: system?.machine.home })

  const moveAgent = async (definition: Definition, family: string) => {
    try {
      const path = await moveDefinition(definition.name, family, data)
      setWrote(`${definition.name} → ${familyTitle(family)} · ${display(path)}`)
      await refetch()
    } catch (failure) {
      store.notify({ level: 'error', message: errorMessage(failure) })
    }
  }
  const moveFeatureTo = async (id: string, family: string) => {
    try {
      await moveFeature(families, id, family)
      setWrote(undefined)
    } catch (failure) {
      store.notify({ level: 'error', message: errorMessage(failure) })
    }
  }

  return (
    <div className="py-2" data-agents-overview>
      <Heading
        meta={
          <>
            <span>
              {definitions.length}
              {errors.length > 0 && <span className="text-error"> · {errors.length} invalid</span>}
            </span>
            <AddFamily view={families} />
            <Button
              className="h-5 gap-1 px-1.5 font-mono text-[0.6875rem] text-muted-foreground hover:text-foreground"
              onClick={() => show('')}
              size="xs"
              title="New agent definition"
              variant="ghost"
            >
              <PlusIcon className="size-3" />
              Agent
            </Button>
          </>
        }
      >
        Agents
      </Heading>
      {families.errors.map((problem) => (
        <p className="px-3 pb-2 font-mono text-[0.6875rem] leading-snug text-error" key={problem}>
          {problem}
        </p>
      ))}
      {wrote && (
        <p
          className="truncate px-3 pb-2 font-mono text-[0.6562rem] text-muted-foreground"
          title={wrote}
        >
          <span className="text-success">saved</span> {wrote}
        </p>
      )}
      {families.families.map((family) => (
        <FamilyGroup family={family} key={family.name} view={families}>
          {definitions
            .filter((definition) => definition.runs?.family === family.name)
            .map((definition) => (
              <AgentRow
                definition={definition}
                discovery={data}
                family={family}
                key={definition.path}
                onMove={(to) => void moveAgent(definition, to)}
                onOpen={() => show(definition.name)}
                view={families}
              />
            ))}
          {features
            .filter((user) => user.family === family.name)
            .map((user) => (
              <Row
                description={user.description}
                icon={SparklesIcon}
                key={user.id}
                label={user.label}
                move={
                  <MoveMenu
                    current={family.name}
                    disabled={!!user.project}
                    label={user.label}
                    onMove={(to) => void moveFeatureTo(user.id, to)}
                    view={families}
                  />
                }
                title={user.project ? "The project's settings decide its family" : undefined}
              />
            ))}
        </FamilyGroup>
      ))}
      {(pinned.length > 0 || pinnedFeatures.length > 0) && (
        <section className="pt-3">
          <div className="flex items-center gap-1.5 px-3 pb-0.5 font-mono text-[0.7188rem] text-muted-foreground">
            <PinIcon className="size-3" />
            Own model
            <span className="text-[0.6562rem] text-muted-foreground">· no family</span>
          </div>
          {pinned.map((definition) => (
            <AgentRow
              definition={definition}
              discovery={data}
              key={definition.path}
              onMove={(to) => void moveAgent(definition, to)}
              onOpen={() => show(definition.name)}
              view={families}
            />
          ))}
          {pinnedFeatures.map((user) => (
            <Row
              description={user.description}
              icon={SparklesIcon}
              key={user.id}
              label={user.label}
              meta={user.pinned && short(user.pinned)}
              move={
                <MoveMenu
                  disabled={!!user.project}
                  label={user.label}
                  onMove={(to) => void moveFeatureTo(user.id, to)}
                  view={families}
                />
              }
              title={user.pinnedIn}
            />
          ))}
        </section>
      )}
      {errors.length > 0 && (
        <section className="pt-3">
          {errors.map((error) => (
            <button
              className="block w-full px-3 py-1 text-left transition-colors hover:bg-accent/50"
              key={error.path}
              onClick={() => show(error.name)}
              title={error.path}
              type="button"
            >
              <div className="flex min-w-0 items-center gap-1.5 font-mono text-[0.7188rem] text-error">
                <BotIcon className="size-3.5 shrink-0" />
                <span className="shrink-0">{error.name}</span>
                <Tag>{error.source}</Tag>
              </div>
              <p className="line-clamp-3 pl-5 font-mono text-[0.6875rem] leading-snug break-words whitespace-pre-wrap text-error/80">
                {parseError(error.error)}
              </p>
            </button>
          ))}
        </section>
      )}
      {definitions.length === 0 && errors.length === 0 && (
        <p className="px-3 pt-3 font-sans text-[0.75rem] leading-relaxed text-muted-foreground">
          No definitions yet: add one with Agent, or Markdown files in{' '}
          <code className="font-mono">.ultimate/agents/</code>
        </p>
      )}
    </div>
  )
}

/** A family's line, which edits it, and who runs on it below, on a thin rule of its color. */
function FamilyGroup({
  family,
  view,
  children,
}: {
  family: FamilyView
  view: FamiliesView
  children: ReactNode
}) {
  const model = runsOn(family)
  const thinking = family.thinking ?? family.followsThinking
  const empty = Array.isArray(children) && children.every((list) => !list || !list.length)
  return (
    <section className="pt-3 first-of-type:pt-1">
      <FamilyPopover family={family} view={view}>
        <button
          className="group/family flex w-full min-w-0 items-center gap-1.5 px-3 py-1 text-left font-mono text-[0.7188rem] transition-colors hover:bg-accent/50 data-[state=open]:bg-accent/50"
          title={`${model ?? 'No model'}${thinking ? ` · thinking ${thinking}` : ''}${family.name === DEFAULT_FAMILY && family.follows ? " (Pi's default)" : ''} · click to change`}
          type="button"
        >
          <FamilyDot color={family.color} />
          <span className="shrink-0 font-medium" style={{ color: familyColor(family.color) }}>
            {familyTitle(family.name)}
          </span>
          <span className="min-w-0 truncate text-muted-foreground">
            {model ? short(model) : 'no model'}
            {thinking && <span className="text-muted-foreground"> · {thinking}</span>}
          </span>
          <span className="ml-auto shrink-0 pl-2 text-[0.6562rem] text-muted-foreground opacity-0 transition-opacity group-hover/family:opacity-100">
            edit
          </span>
        </button>
      </FamilyPopover>
      <div
        className="ml-[1.0625rem] border-l"
        style={{ borderColor: `${familyColor(family.color)}40` }}
      >
        {children}
        {empty && (
          <p className="py-1 pl-2.5 font-mono text-[0.6562rem] text-muted-foreground">
            nothing runs on it
          </p>
        )}
      </div>
    </section>
  )
}

function AgentRow({
  definition,
  family,
  view,
  onOpen,
  onMove,
}: {
  definition: Definition
  discovery: Discovery
  /** The family it runs on; undefined while it pins a model. */
  family?: FamilyView
  view: FamiliesView
  onOpen: () => void
  onMove: (family: string) => void
}) {
  const thinking = definition.runs?.thinking ?? definition.thinking
  const familyThinking = family?.thinking ?? family?.followsThinking
  return (
    <Row
      description={definition.description}
      icon={BotIcon}
      label={definition.name}
      meta={
        <>
          {!family && definition.model && short(`/${definition.model.modelId}`)}
          {thinking && thinking !== familyThinking && <span> · {thinking}</span>}
        </>
      }
      move={<MoveMenu current={family?.name} label={definition.name} onMove={onMove} view={view} />}
      onOpen={onOpen}
      tags={
        <>
          {definition.source !== 'builtin' && <Tag>{definition.source}</Tag>}
          {definition.isolate === 'worktree' && <Tag>worktree</Tag>}
        </>
      }
      title={[
        definition.path,
        definition.model && `pins ${definition.model.provider}/${definition.model.modelId}`,
        `tools: ${definition.tools?.join(', ') ?? 'inherited'}`,
      ]
        .filter(Boolean)
        .join('\n')}
    />
  )
}

/** One agent or feature: name, tags and the thinking or model it adds, its description, and a family dot to move it. */
function Row({
  icon: Icon,
  label,
  description,
  tags,
  meta,
  move,
  title,
  onOpen,
}: {
  icon: typeof BotIcon
  label: string
  description: string
  tags?: ReactNode
  meta?: ReactNode
  move: ReactNode
  title?: string
  onOpen?: () => void
}) {
  const body = (
    <>
      <div className="flex min-w-0 items-center gap-1.5 font-mono text-[0.7188rem]">
        <Icon className="size-3 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-foreground/85">{label}</span>
        {tags}
        {meta && (
          <span className="min-w-0 truncate text-[0.6562rem] text-muted-foreground">{meta}</span>
        )}
      </div>
      <p className="line-clamp-1 pl-4.5 font-sans text-[0.7188rem] leading-snug text-muted-foreground">
        {description}
      </p>
    </>
  )
  return (
    <div
      className="group/row flex min-w-0 items-start transition-colors hover:bg-accent/40"
      title={title}
    >
      {onOpen ? (
        <button className="min-w-0 flex-1 py-1 pl-2.5 text-left" onClick={onOpen} type="button">
          {body}
        </button>
      ) : (
        <div className="min-w-0 flex-1 py-1 pl-2.5">{body}</div>
      )}
      <div className="shrink-0 pt-1 pr-2">{move}</div>
    </div>
  )
}

/** "Run on": the families as a menu, the current one ticked. */
function MoveMenu({
  current,
  view,
  label,
  disabled,
  onMove,
}: {
  current?: string
  view: FamiliesView
  label: string
  disabled?: boolean
  onMove: (family: string) => void
}) {
  const family = view.families.find((item) => item.name === current)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          aria-label={`Move ${label} to another family`}
          className="flex h-5 items-center gap-1 rounded px-1 font-mono text-[0.6562rem] text-muted-foreground/0 transition-colors group-hover/row:text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:text-muted-foreground disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-foreground pointer-coarse:text-muted-foreground"
          title={disabled ? "The project's settings decide it" : 'Run it on another family'}
          type="button"
        >
          move
          {family ? (
            <FamilyDot className="size-1.5" color={family.color} />
          ) : (
            <PinIcon className="size-2.5" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 font-mono">
        <DropdownMenuLabel className="section-label">Run {label} on</DropdownMenuLabel>
        {view.families.map((item) => {
          const model = runsOn(item)
          return (
            <DropdownMenuItem
              className="gap-2 py-1 text-[0.75rem]"
              key={item.name}
              onSelect={() => item.name !== current && onMove(item.name)}
            >
              <CheckIcon
                className={cn('size-3.5', item.name === current ? 'text-brand' : 'opacity-0')}
              />
              <FamilyDot color={item.color} />
              <span style={{ color: familyColor(item.color) }}>{familyTitle(item.name)}</span>
              <span className="ml-auto truncate text-[0.6562rem] text-muted-foreground">
                {model ? short(model) : ''}
              </span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
