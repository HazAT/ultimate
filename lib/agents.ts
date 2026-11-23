import { readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { clampThinkingLevel } from '@earendil-works/pi-ai'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { Agent, AgentChange } from '@earendil-works/pi-durable'
import { parseFrontmatter, resolveCliModel } from '@earendil-works/pi-coding-agent'
import type { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent'
import type { Source } from './project-paths.ts'
import { writeTextAtomically } from './json-file.ts'
import { isIconName, isMarkTint, markTints } from './marks.ts'
import type { MarkTint } from './marks.ts'
import { DEFAULT_FAMILY, definitionRuns, isFamilyName, refName, refOf } from './families.ts'
import type { Families } from './families.ts'
import { readFamilies } from './families-settings.ts'
import { projectDecision, readDecision, useProjectSetup } from './project-setup.ts'
import { discoverExtensions } from './discovery.ts'
import { isMissing } from './errors.ts'

type DeferredToolNamesWhenInheritingAll = string[]
export interface AgentDefinition {
  name: string
  description: string
  path: string
  instructions: string
  model?: { provider: string; modelId: string }
  thinking?: ModelThinkingLevel
  family?: string
  runs?: ReturnType<typeof definitionRuns>
  tools?: string[]
  addTools?: DeferredToolNamesWhenInheritingAll
  denyTools?: string[]
  skills?: string[]
  isolate?: 'none' | 'worktree'
  resident?: boolean
  fast?: boolean
  summaries?: boolean
  title?: string
  icon?: string
  tint?: MarkTint
  overlays?: string[]
}
export function previewModel(env: NodeJS.ProcessEnv = process.env) {
  const value = env.ULTIMATE_MODEL
  const slash = value?.indexOf('/') ?? -1
  if (!value || slash <= 0 || slash === value.length - 1) return undefined
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) }
}

type ModelRef = { provider: string; modelId: string }
type Listed = { provider: string; id: string }

export const hasLogin = (available: readonly Listed[], ref: ModelRef | undefined) =>
  !!ref && available.some((model) => model.provider === ref.provider && model.id === ref.modelId)

export function defaultModel(
  available: readonly Listed[],
  settings: Pick<SettingsManager, 'getDefaultProvider' | 'getDefaultModel'>,
  family?: ModelRef,
): ModelRef | undefined {
  const firstLoggedInModel = available[0]
  return (
    configuredModel(available, settings, family) ??
    configuredModelsInPriorityOrder(settings, family)[0] ??
    (firstLoggedInModel && {
      provider: firstLoggedInModel.provider,
      modelId: firstLoggedInModel.id,
    })
  )
}

const configuredModelsInPriorityOrder = (
  settings: Pick<SettingsManager, 'getDefaultProvider' | 'getDefaultModel'>,
  family?: ModelRef,
) =>
  [
    previewModel(),
    family,
    { provider: settings.getDefaultProvider(), modelId: settings.getDefaultModel() },
  ].filter((ref): ref is ModelRef => !!ref?.provider && !!ref.modelId)

export function configuredModel(
  available: readonly Listed[],
  settings: Pick<SettingsManager, 'getDefaultProvider' | 'getDefaultModel'>,
  family?: ModelRef,
): ModelRef | undefined {
  return configuredModelsInPriorityOrder(settings, family).find((ref) => hasLogin(available, ref))
}

type DefaultSettings = Pick<
  SettingsManager,
  'getDefaultProvider' | 'getDefaultModel' | 'getDefaultThinkingLevel'
>
type DefaultHost = {
  modelRuntime: Pick<ModelRuntime, 'getAvailableSnapshot'>
  settings: DefaultSettings
  userHome: string
  projectRoot: string
}

export const familyDefault = async (host: Pick<DefaultHost, 'userHome' | 'projectRoot'>) =>
  refOf((await readFamilies(host.userHome, host.projectRoot)).families[DEFAULT_FAMILY].model)

export function defaultAgent(
  available: readonly Listed[],
  settings: DefaultSettings,
  family: Families['families'][string],
): { model?: ModelRef; thinkingLevel?: ModelThinkingLevel } {
  const model = defaultModel(available, settings, refOf(family.model))
  const thinkingLevel = family.thinking ?? settings.getDefaultThinkingLevel()
  return { ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) }
}

export const hostDefault = async (host: DefaultHost) =>
  defaultAgent(
    host.modelRuntime.getAvailableSnapshot(),
    host.settings,
    (await readFamilies(host.userHome, host.projectRoot)).families[DEFAULT_FAMILY],
  )

export function onFamily(
  definition: AgentDefinition,
  name: string,
  families: Families,
  available: readonly Listed[],
): AgentDefinition {
  const names = Object.keys(families.families).join(', ')
  if (!Object.hasOwn(families.families, name))
    throw new Error(`Unknown family: ${name}. Families: ${names}`)
  const runs = definitionRuns({ family: name }, families)
  if (runs.model && !previewModel() && !hasLogin(available, runs.model))
    throw new Error(`No login for ${refName(runs.model)} (family ${name}). Families: ${names}`)
  return { ...definition, runs }
}

export function definitionFamily(
  definition: AgentDefinition | undefined,
  change: Pick<AgentChange, 'model'>,
): string | null {
  const runs = definition?.runs
  if (runs?.via !== 'family' || !runs.family) return null
  if (!runs.model || previewModel()) return runs.family
  const model = change.model
  const stillOnAssignedFamilyModel =
    model?.provider === runs.model.provider && model.modelId === runs.model.modelId
  return stillOnAssignedFamilyModel ? runs.family : null
}

export function definitionAgent(
  definition: AgentDefinition | undefined,
  parent: Agent,
  modelRuntime: ModelRuntime,
  {
    excludeTools: excluded = [],
    excludeExtensions = [],
    model: overrideModel,
    thinking: overrideThinking,
  }: {
    excludeTools?: string[]
    excludeExtensions?: string[]
    model?: { provider: string; modelId: string }
    thinking?: ModelThinkingLevel
  } = {},
): AgentChange {
  const excludeTools = [...excluded, ...(definition?.denyTools ?? [])]
  const familyResolvedModelOrOwnPin = definition?.runs ? definition.runs.model : definition?.model
  const loggedInPin = hasLogin(modelRuntime.getAvailableSnapshot(), familyResolvedModelOrOwnPin)
    ? familyResolvedModelOrOwnPin
    : undefined
  const ref = previewModel() ?? overrideModel ?? loggedInPin ?? parent.model
  const model = ref && modelRuntime.getModel(ref.provider, ref.modelId)
  const thinking =
    overrideThinking ??
    (definition?.runs ? definition.runs.thinking : definition?.thinking) ??
    parent.thinkingLevel
  const tools = [
    ...new Map([...parent.tools, ...parent.deferred].map((tool) => [tool.name, tool])).values(),
  ]
  const named = [...(definition?.tools ?? []), ...(definition?.addTools ?? [])]
  const offered = tools.filter(
    (tool) =>
      !excludeTools.includes(tool.name) &&
      (!definition?.tools || definition.tools.includes(tool.name)),
  )
  const scriptOnly = offered.some((tool) => tool.name === 'codemode')
    ? parent.callable.filter(
        (tool) => tool.callers?.includes('model') === false && !excludeTools.includes(tool.name),
      )
    : []
  return {
    modelTools: {
      add: tools.filter(
        (tool) => tool.deferred && !excludeTools.includes(tool.name) && named.includes(tool.name),
      ),
    },
    tools: [...offered, ...scriptOnly],
    extensions: parent.extensions.filter(
      (extension) => !excludeExtensions.includes(extension.name),
    ),
    instructions: definition?.instructions ?? parent.instructions ?? null,
    model: ref ?? null,
    thinkingLevel: thinking && model ? clampThinkingLevel(model, thinking) : (thinking ?? null),
  }
}

export interface AgentDiscovery {
  definitions: (AgentDefinition & { source: Source })[]
  errors: { name: string; path: string; source: Source; error: string }[]
  replaced: { name: string; path: string; source: Source }[]
  projectSetup: 'trusted' | 'declined' | 'undecided'
}
const exhaustivePiThinkingLevels = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
} satisfies Record<ModelThinkingLevel, true>
const fields = new Set([
  'name',
  'description',
  'model',
  'thinking',
  'family',
  'tools',
  'denyTools',
  'skills',
  'isolate',
  'resident',
  'fast',
  'summaries',
  'title',
  'icon',
  'tint',
])

function parseSettings(frontmatter: Record<string, unknown>): Partial<
  Pick<
    AgentDefinition,
    | 'description'
    | 'thinking'
    | 'family'
    | 'isolate'
    | 'resident'
    | 'fast'
    | 'summaries'
    | 'denyTools'
    | 'skills'
    | 'title'
    | 'icon'
    | 'tint'
  >
> & {
  model?: string
} {
  const {
    description,
    model,
    thinking,
    family,
    isolate,
    resident,
    fast,
    summaries,
    denyTools,
    skills,
    title,
    icon,
    tint,
  } = frontmatter
  if (family !== undefined && (typeof family !== 'string' || !isFamilyName(family)))
    throw new Error('family must be a family name: lowercase letters, digits and -')
  if (denyTools !== undefined && !isTools(denyTools))
    throw new Error('denyTools must be a list of tool names')
  if (skills !== undefined && !isTools(skills))
    throw new Error('skills must be a list of skill names')
  if (description !== undefined && (typeof description !== 'string' || !description.trim()))
    throw new Error('description is required')
  if (
    thinking !== undefined &&
    (typeof thinking !== 'string' || !Object.hasOwn(exhaustivePiThinkingLevels, thinking))
  )
    throw new Error(`thinking must be one of ${Object.keys(exhaustivePiThinkingLevels).join(', ')}`)
  if (model !== undefined && (typeof model !== 'string' || !model.trim()))
    throw new Error('model must be a nonempty string')
  if (isolate !== undefined && isolate !== 'none' && isolate !== 'worktree')
    throw new Error('isolate must be none or worktree')
  if (resident !== undefined && typeof resident !== 'boolean')
    throw new Error('resident must be a boolean')
  if (fast !== undefined && typeof fast !== 'boolean') throw new Error('fast must be a boolean')
  if (summaries !== undefined && typeof summaries !== 'boolean')
    throw new Error('summaries must be a boolean')
  if (title !== undefined && (typeof title !== 'string' || !title.trim()))
    throw new Error('title must be a nonempty string')
  if (icon !== undefined && !isIconName(icon))
    throw new Error('icon must be a lucide icon name, like Gem or notebook-pen')
  if (tint !== undefined && !isMarkTint(tint))
    throw new Error(`tint must be one of ${markTints.join(', ')}`)
  return {
    ...(description !== undefined ? { description: description.trim() } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(thinking ? { thinking: thinking as ModelThinkingLevel } : {}),
    ...(family ? { family: family } : {}),
    ...(isolate ? { isolate: isolate } : {}),
    ...(resident !== undefined ? { resident: resident } : {}),
    ...(fast !== undefined ? { fast } : {}),
    ...(summaries !== undefined ? { summaries } : {}),
    ...(denyTools !== undefined ? { denyTools } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(title !== undefined ? { title: title.trim() } : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...(tint !== undefined ? { tint } : {}),
  }
}

const isTools = (tools: unknown): tools is string[] =>
  Array.isArray(tools) && tools.every((tool) => typeof tool === 'string')

export function parseDefinition(
  text: string,
  path: string,
): Omit<AgentDefinition, 'model'> & { model?: string } {
  const { frontmatter, body } = parseFrontmatter(text)
  const missingFrontmatterFields =
    typeof frontmatter !== 'object' ||
    Array.isArray(frontmatter) ||
    !Object.keys(frontmatter).length
  if (missingFrontmatterFields) throw new Error('Expected frontmatter fields between --- lines')
  const { name, tools } = frontmatter
  const unknown = Object.keys(frontmatter).find((key) => !fields.has(key))
  if (unknown) throw new Error(`Unknown field: ${unknown}`)
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(name))
    throw new Error('name must be a nonempty identifier')
  const { description, ...settings } = parseSettings(frontmatter)
  if (!description) throw new Error('description is required')
  if (tools !== undefined && !isTools(tools)) throw new Error('tools must be a list of tool names')
  if (!body) throw new Error('Instructions are required')
  return {
    name,
    description,
    path,
    instructions: body,
    ...settings,
    ...(tools ? { tools } : {}),
  }
}

function resolveModel(
  cliModel: string | undefined,
  cliThinking: ModelThinkingLevel | undefined,
  modelRuntime: ModelRuntime,
) {
  const resolved = resolveCliModel({ cliModel, cliThinking, modelRuntime })
  if (resolved.error || resolved.warning)
    throw new Error(`model: ${resolved.error || resolved.warning}`)
  const thinking = cliThinking ?? resolved.thinkingLevel
  return {
    ...(resolved.model
      ? { model: { provider: resolved.model.provider, modelId: resolved.model.id } }
      : {}),
    ...(thinking ? { thinking } : {}),
  }
}

export function parseOverlay(text: string, path: string, modelRuntime: ModelRuntime) {
  const { frontmatter, body } = parseFrontmatter(text)
  const { name, addTools } = frontmatter
  if ('tools' in frontmatter) throw new Error('An overlay adds tools with addTools, not tools')
  const unknown = Object.keys(frontmatter).find((key) => key !== 'addTools' && !fields.has(key))
  if (unknown) throw new Error(`Unknown field: ${unknown}`)
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(name))
    throw new Error('name must be a nonempty identifier')
  if (!isTools(addTools)) throw new Error('addTools must be a list of tool names')
  const { model, thinking, ...settings } = parseSettings(frontmatter)
  return {
    name,
    path,
    addTools,
    settings: { ...settings, ...resolveModel(model, thinking, modelRuntime) },
    instructions: body.trim(),
  }
}

const isOverlay = (text: string) => {
  const { frontmatter } = parseFrontmatter(text)
  return typeof frontmatter === 'object' && !Array.isArray(frontmatter) && 'addTools' in frontmatter
}

function readDefinition(text: string, path: string, modelRuntime: ModelRuntime): AgentDefinition {
  const { model, thinking, ...definition } = parseDefinition(text, path)
  return { ...definition, ...resolveModel(model, thinking, modelRuntime) }
}

export async function agentRoots(ultimateRoot: string, projectRoot: string, userHome: string) {
  const extensions = (await discoverExtensions(ultimateRoot, projectRoot, userHome)).filter(
    (extension) => extension.enabled,
  )
  const trust = readDecision(projectRoot, userHome)
  const projectAgents = join(projectRoot, '.ultimate/agents')
  const errors: AgentDiscovery['errors'] = [
    ...extensions.flatMap((extension) =>
      extension.error === undefined
        ? []
        : [
            {
              name: extension.name,
              path: extension.path,
              source: extension.source,
              error: extension.error,
            },
          ],
    ),
    ...(trust.error === undefined
      ? []
      : [
          {
            name: projectAgents,
            path: projectAgents,
            source: 'project' as const,
            error: trust.error,
          },
        ]),
  ]
  const roots = [
    { source: 'builtin' as const, path: join(ultimateRoot, 'agents') },
    ...extensions
      .filter((extension) => extension.files.includes('agents'))
      .map((extension) => ({ source: 'builtin' as const, path: join(extension.path, 'agents') })),
    { source: 'user' as const, path: join(userHome, '.ultimate/agents') },
    ...(trust.decision === true ? [{ source: 'project' as const, path: projectAgents }] : []),
  ]
  return Object.assign(roots, { errors })
}

export async function discoverAgents(
  ultimateRoot: string,
  projectRoot: string,
  userHome: string,
  modelRuntime: ModelRuntime,
  skipOverlayToReadItsBase?: string,
): Promise<AgentDiscovery> {
  const definitions = new Map<string, AgentDefinition & { source: Source }>()
  const roots = await agentRoots(ultimateRoot, projectRoot, userHome)
  const errors: AgentDiscovery['errors'] = [...roots.errors]
  const builtins = new Set<string>()
  const replaced: AgentDiscovery['replaced'] = []
  for (const { source, path: directory } of roots) {
    let files: string[]
    try {
      files = await readdir(directory)
    } catch (error) {
      if (!isMissing(error))
        errors.push({ name: directory, path: directory, source, error: String(error) })
      continue
    }
    for (const file of files.filter((entry) => entry.endsWith('.md')).toSorted()) {
      const path = join(directory, file)
      if (path === skipOverlayToReadItsBase) continue
      try {
        const text = await readFile(path, 'utf8')
        if (isOverlay(text)) {
          const overlay = parseOverlay(text, path, modelRuntime)
          const base = definitions.get(overlay.name)
          if (!base) throw new Error(`addTools needs an earlier definition named ${overlay.name}`)
          const heading = source === 'user' ? 'User additions' : 'Project additions'
          const { model: _pin, ...unpinned } = base
          const familyReplacesEarlierPin = overlay.settings.family && !overlay.settings.model
          definitions.set(overlay.name, {
            ...(familyReplacesEarlierPin ? unpinned : base),
            ...overlay.settings,
            ...(overlay.settings.denyTools
              ? {
                  denyTools: [
                    ...new Set([...(base.denyTools ?? []), ...overlay.settings.denyTools]),
                  ],
                }
              : {}),
            ...(base.tools
              ? { tools: [...new Set([...base.tools, ...overlay.addTools])] }
              : overlay.addTools.length
                ? { addTools: [...new Set([...(base.addTools ?? []), ...overlay.addTools])] }
                : {}),
            instructions: overlay.instructions
              ? `${base.instructions}\n\n## ${heading}\n\n${overlay.instructions}`
              : base.instructions,
            overlays: [...(base.overlays ?? []), path],
          })
          continue
        }
        const definition = readDefinition(text, path, modelRuntime)
        if (source === 'builtin') builtins.add(definition.name)
        else if (builtins.has(definition.name))
          replaced.push({ name: definition.name, path, source })
        definitions.set(definition.name, { ...definition, source })
      } catch (error) {
        errors.push({ name: file.slice(0, -3), path, source, error: String(error) })
      }
    }
  }
  const decision = projectDecision(projectRoot, userHome)
  const families = await readFamilies(userHome, projectRoot)
  return {
    definitions: [...definitions.values()].map((definition) => ({
      ...definition,
      runs: definitionRuns(definition, families),
    })),
    errors,
    replaced,
    projectSetup: decision === true ? 'trusted' : decision === false ? 'declined' : 'undecided',
  }
}

export interface DefinitionFields {
  description: string
  model?: string
  thinking?: string
  family?: string
  tools?: string[]
  denyTools?: string[]
  skills?: string[]
  isolate?: 'none' | 'worktree'
  resident?: boolean
  fast?: boolean
  summaries?: boolean
  title?: string
  icon?: string
  tint?: MarkTint
}

const toolList = (tools: string[]) => {
  const safeUnquotedFlowItem = /^[\w.-]+$/
  return `[${tools.map((tool) => (safeUnquotedFlowItem.test(tool) ? scalar(tool) : JSON.stringify(tool))).join(', ')}]`
}

function scalar(value: string) {
  try {
    const plainScalarRoundTripsUnchanged =
      parseFrontmatter(`---\nvalue: ${value}\n---\n`).frontmatter.value === value
    if (plainScalarRoundTripsUnchanged) return value
  } catch {
    return JSON.stringify(value)
  }
  return JSON.stringify(value)
}

export function serializeDefinition(
  name: string,
  frontmatter: DefinitionFields,
  instructions: string,
) {
  const lines = [
    `name: ${scalar(name)}`,
    `description: ${scalar(frontmatter.description.trim())}`,
    ...(frontmatter.model ? [`model: ${scalar(frontmatter.model)}`] : []),
    ...(frontmatter.thinking ? [`thinking: ${scalar(frontmatter.thinking)}`] : []),
    ...(frontmatter.family ? [`family: ${scalar(frontmatter.family)}`] : []),
    ...(frontmatter.tools ? [`tools: ${toolList(frontmatter.tools)}`] : []),
    ...(frontmatter.denyTools?.length ? [`denyTools: ${toolList(frontmatter.denyTools)}`] : []),
    ...(frontmatter.skills ? [`skills: ${toolList(frontmatter.skills)}`] : []),
    ...(frontmatter.isolate === 'worktree' ? ['isolate: worktree'] : []),
    ...(frontmatter.resident !== undefined ? [`resident: ${frontmatter.resident}`] : []),
    ...(frontmatter.fast ? ['fast: true'] : []),
    ...(frontmatter.summaries === false ? ['summaries: false'] : []),
    ...(frontmatter.title ? [`title: ${scalar(frontmatter.title)}`] : []),
    ...(frontmatter.icon ? [`icon: ${scalar(frontmatter.icon)}`] : []),
    ...(frontmatter.tint ? [`tint: ${frontmatter.tint}`] : []),
  ]
  return `---\n${lines.join('\n')}\n---\n\n${instructions.trim()}\n`
}

function scopeRoot(scope: 'user' | 'project', projectRoot: string, userHome: string) {
  if (scope === 'user') return join(userHome, '.ultimate/agents')
  if (!useProjectSetup(projectRoot, userHome))
    throw new Error("Choose this project's local setup before saving project definitions")
  return join(projectRoot, '.ultimate/agents')
}

export async function saveDefinition(
  roots: { projectRoot: string; userHome: string },
  modelRuntime: ModelRuntime,
  scope: 'user' | 'project',
  name: string,
  frontmatter: DefinitionFields,
  instructions: string,
) {
  const directory = scopeRoot(scope, roots.projectRoot, roots.userHome)
  const text = serializeDefinition(name, frontmatter, instructions)
  const validatedBeforePathWrite = readDefinition(text, join(directory, `${name}.md`), modelRuntime)
  await writeTextAtomically(validatedBeforePathWrite.path, text)
  return { ...validatedBeforePathWrite, source: scope }
}

export async function saveOverlay(
  roots: { ultimateRoot: string; projectRoot: string; userHome: string },
  modelRuntime: ModelRuntime,
  scope: 'user' | 'project',
  name: string,
  form: DefinitionFields,
  instructions: string,
) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('name must be a nonempty identifier')
  const path = join(scopeRoot(scope, roots.projectRoot, roots.userHome), `${name}.md`)
  const { ultimateRoot, projectRoot, userHome } = roots
  const { definitions } = await discoverAgents(
    ultimateRoot,
    projectRoot,
    userHome,
    modelRuntime,
    path,
  )
  const base = definitions.find((definition) => definition.name === name)
  if (!base) throw new Error(`No definition named ${name} for an overlay to extend`)
  const projectRootsInUserScope = (await agentRoots(ultimateRoot, projectRoot, userHome))
    .filter((root) => scope === 'user' && root.source === 'project')
    .map((root) => root.path)
  const shadowing = [base.path, ...(base.overlays ?? [])].find((file) =>
    projectRootsInUserScope.includes(dirname(file)),
  )
  if (shadowing) throw new Error(`${shadowing} applies over the ${scope} file: save to project`)

  const cannot = (what: string) =>
    new Error(`An overlay cannot ${what}: edit ${base.path}, or Duplicate ${name}`)
  const settings: string[] = []
  if (form.description.trim() !== base.description)
    settings.push(`description: ${scalar(form.description.trim())}`)
  const baseModel = base.model && `${base.model.provider}/${base.model.modelId}`
  const familyMustReplaceBasePin = !form.model && !!baseModel
  if (familyMustReplaceBasePin && !form.family) throw cannot('clear the model without a family')
  if (form.model && form.model !== baseModel) settings.push(`model: ${scalar(form.model)}`)
  if (form.thinking !== base.thinking) {
    if (!form.thinking) throw cannot('clear thinking')
    settings.push(`thinking: ${scalar(form.thinking)}`)
  }
  if (form.family !== base.family || familyMustReplaceBasePin) {
    if (!form.family) throw cannot('clear the family')
    settings.push(`family: ${scalar(form.family)}`)
  }
  if ((form.isolate ?? 'none') !== (base.isolate ?? 'none'))
    settings.push(`isolate: ${form.isolate ?? 'none'}`)
  if ((form.resident ?? false) !== (base.resident ?? false))
    settings.push(`resident: ${form.resident ?? false}`)
  if ((form.fast ?? false) !== (base.fast ?? false)) settings.push(`fast: ${form.fast ?? false}`)
  if ((form.summaries ?? true) !== (base.summaries ?? true))
    settings.push(`summaries: ${form.summaries ?? true}`)
  if (form.title && form.title !== base.title) settings.push(`title: ${scalar(form.title)}`)
  if (form.icon && form.icon !== base.icon) settings.push(`icon: ${scalar(form.icon)}`)
  if (form.tint && form.tint !== base.tint) settings.push(`tint: ${form.tint}`)
  if (form.skills?.join() !== base.skills?.join()) {
    if (!form.skills) throw cannot('give every skill back')
    settings.push(`skills: ${toolList(form.skills)}`)
  }

  if (!base.tools && form.tools) throw cannot('limit the tools of a definition that inherits all')
  if (base.tools && !form.tools) throw cannot('make it inherit every tool')
  const removed = base.tools?.filter((tool) => !form.tools?.includes(tool)) ?? []
  if (removed.length) throw cannot(`remove ${removed.join(', ')}`)
  const addTools =
    form.tools?.filter((tool) => !base.tools?.includes(tool)) ??
    (await readFile(path, 'utf8').then(
      (text) => {
        const kept = parseFrontmatter(text).frontmatter.addTools
        return isTools(kept) ? kept : []
      },
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      },
    ))
  const baseDeny = base.denyTools ?? []
  const undenied = baseDeny.filter((tool) => !form.denyTools?.includes(tool))
  if (undenied.length) throw cannot(`allow ${undenied.join(', ')} again`)
  const denyTools = (form.denyTools ?? []).filter((tool) => !baseDeny.includes(tool))
  if (denyTools.length) settings.push(`denyTools: ${toolList(denyTools)}`)

  const start = base.instructions.trim()
  const text = instructions.trim()
  if (!text.startsWith(start)) throw cannot('change the instructions it starts with')
  const heading = `## ${scope === 'user' ? 'User' : 'Project'} additions`
  let body = text.slice(start.length).trim()
  if (body.startsWith(heading)) body = body.slice(heading.length).trim()

  const overlay = `---\n${[`name: ${scalar(name)}`, `addTools: ${toolList(addTools)}`, ...settings].join('\n')}\n---\n${body ? `\n${body}\n` : ''}`
  parseOverlay(overlay, path, modelRuntime)
  await writeTextAtomically(path, overlay)
  return { path }
}

export async function deleteDefinition(
  roots: { projectRoot: string; userHome: string },
  scope: 'user' | 'project',
  name: string,
) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('name must be a nonempty identifier')
  const path = join(scopeRoot(scope, roots.projectRoot, roots.userHome), `${name}.md`)
  try {
    await rm(path)
  } catch (error) {
    if (isMissing(error)) throw new Error(`No ${scope} definition named ${name}`, { cause: error })
    throw error
  }
  return { path }
}
