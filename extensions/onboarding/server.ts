import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { loadSkillsFromDir, parseFrontmatter } from '@earendil-works/pi-coding-agent'
import {
  defineDoc,
  defineEntry,
  defineExtension,
  defineTool,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import { obj, oneOf } from '@earendil-works/pi-schema'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { Conversation, ConversationId } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { isolatable } from '../../lib/git.ts'
import { writeJson } from '../../lib/json-file.ts'
import { readSettings, updateSettings, userSettingsPath } from '../../lib/settings.ts'
import type { JsonObject } from '@earendil-works/pi-durable'
import type { ExtensionAction } from '../../server/actions.ts'
import { SubagentsApi } from '../subagents/api.ts'
import { LineageApi } from '../lineage/api.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import { implementAction } from '../../lib/actions.ts'
import { contractOutline } from '../../lib/api-files.ts'
import {
  AdoptProjectSetupAction,
  ChooseAction,
  DecideAction,
  DetailsAction,
  DismissAction,
  ExtensionsAction,
  FirstRunDoneAction,
  HelpAction,
  SetExtensionAction,
  StartAction,
  StartsDoc,
  StatusAction,
  WalkthroughAction,
} from './refs.ts'

export const Starts = defineDoc<{ roots: Record<string, number>; dismissed?: boolean }>({
  kind: StartsDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ roots: {} }),
})
const ChoiceRequests = defineDoc<{ payloads: Record<string, JsonObject> }>({
  kind: 'onboarding.choice-requests',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ payloads: {} }),
})
export const docs = [Starts]
export const StartEntry = defineEntry<{
  root: number
  instructions?: string
  facts: {
    project: { name: string; path: string }
    firstRun: boolean
    projectUndecided: boolean
    gitReason?: string
    root: number
    rootEmpty: boolean
  }
}>('onboarding.start')
export const WalkthroughEntry = defineEntry<Record<string, never>>('walkthrough.start')

function lists(value: JsonObject) {
  const extensions = value.extensions ?? {}
  if (typeof extensions !== 'object' || Array.isArray(extensions))
    throw new Error('extensions must be a JSON object')
  const result = extensions
  for (const key of ['enable', 'disable']) {
    const names = result[key]
    if (
      names !== undefined &&
      (!Array.isArray(names) || names.some((name) => typeof name !== 'string'))
    )
      throw new Error(`extensions.${key} must be an array of names`)
  }
  value.extensions = result
  return result
}
function toggle(extensions: JsonObject, name: string, enabled: boolean) {
  const key = enabled ? 'enable' : 'disable'
  const opposite = enabled ? 'disable' : 'enable'
  extensions[key] = [...new Set([...((extensions[key] as string[]) ?? []), name])]
  if (extensions[opposite] !== undefined)
    extensions[opposite] = (extensions[opposite] as string[]).filter((entry) => entry !== name)
}
/** Names of the project's own agents and skills, read but never loaded, so an undecided project can show them. */
async function adds(projectRoot: string) {
  const directory = join(projectRoot, '.ultimate/agents')
  const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return []
  })
  const agents = await Promise.all(
    files
      .filter((file) => file.endsWith('.md'))
      .toSorted()
      .map(async (file) => {
        try {
          const { name } = parseFrontmatter(
            await readFile(join(directory, file), 'utf8'),
          ).frontmatter
          if (typeof name === 'string' && name.trim()) return name.trim()
        } catch {
          // An invalid definition still shows by its file name; the subagents extension reports the error.
        }
        return basename(file, '.md')
      }),
  )
  const skills = loadSkillsFromDir({
    dir: join(projectRoot, '.ultimate/skills'),
    source: 'project',
  })
    .skills.map((skill) => skill.name)
    .toSorted()
  return { agents, skills, ...(await declared(join(projectRoot, '.ultimate/settings.json'))) }
}

const names = (value: unknown) =>
  Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : []

/**
 * The extension names a settings file enables and disables, read only to show them: a project's settings apply once
 * the project is chosen, so the host's gated settings are empty until then.
 */
async function declared(path: string) {
  try {
    const { extensions } = JSON.parse(await readFile(path, 'utf8')) as {
      extensions?: { enable?: unknown; disable?: unknown }
    }
    return { enable: names(extensions?.enable), disable: names(extensions?.disable) }
  } catch {
    return { enable: [], disable: [] }
  }
}

const marker = (userHome: string) => join(userHome, '.ultimate/onboarding.json')

/** The walkthrough's model fact: @ultimate's model and context window, so beat 4 can recommend 1M+. */
async function modelLine(host: ExtensionHost, conversation: Conversation) {
  const ref = (await conversation.agent(context)).model
  const model = (await host.models()).find(
    (candidate) => candidate.provider === ref?.provider && candidate.id === ref?.modelId,
  )
  return model
    ? `Model: ${model.provider}/${model.id}, context window ${model.contextWindow} tokens`
    : 'Model: unknown'
}

export const userActions = [
  'start',
  'dismiss',
  'walkthrough',
  'help',
  'choose',
  'decide',
  'setExtension',
  'adoptProjectSetup',
  'applyFirstRun',
  'firstRunDone',
]

export const actions: Record<string, ExtensionAction> = {
  help: implementAction(HelpAction, async (args, { host }) => {
    const card = args && typeof args === 'object' && !Array.isArray(args) ? args.card : undefined
    if (card !== 'project' && card !== 'git') throw new Error('Expected project or git card')
    const id = await host.need(SubagentsApi).standing('ultimate', context)
    const conversation = (await host.harness().conversation(id, context))!
    await conversation.submit(
      {
        type: 'input',
        content:
          card === 'project'
            ? "Help me decide whether to use this project's setup."
            : 'Help me set up git for this folder.',
        whenBusy: 'followUp',
      },
      context,
    )
    return { id }
  }),
  start: implementAction(StartAction, async (args, { host, conversationId }) => {
    const input = args as { root?: number; instructions?: string } | null
    if (
      input !== null &&
      (typeof input !== 'object' ||
        Array.isArray(input) ||
        (input.root !== undefined && (!Number.isSafeInteger(input.root) || input.root < 1)) ||
        (input.instructions !== undefined && typeof input.instructions !== 'string'))
    )
      throw new Error('Expected root id and optional instructions')
    const lineage = host.need(LineageApi)
    const root =
      input?.root ??
      (conversationId === undefined ? undefined : await lineage.rootOf(conversationId, context)) ??
      1
    const harness = host.harness()
    const existing = (await harness.snapshot(Starts, ROOT_CONVERSATION_ID, context))?.roots[
      String(root)
    ]
    if (existing !== undefined) return { id: existing }
    if ((await lineage.rootOf(root, context)) !== root) throw new Error('Expected a project root')
    const id = await host.need(SubagentsApi).standing('ultimate', context)
    const project = await host.projectSetup()
    const checkout = await isolatable(host.projectRoot)
    const facts = {
      project: { name: basename(host.projectRoot), path: host.projectRoot },
      firstRun: !existsSync(marker(host.userHome)),
      projectUndecided: project.config && project.decision === null,
      ...('reason' in checkout ? { gitReason: checkout.reason } : {}),
      root,
      rootEmpty: await harness.commit(
        async (tx) =>
          !(await tx.scanEntries({ conversationId: root as ConversationId }, 1)).items.length,
        context,
      ),
    }
    const instructions = input?.instructions
    const conversation = (await harness.conversation(id, context))!
    await conversation.submit(
      {
        type: 'input',
        content: [
          'Onboarding started.',
          await modelLine(host, conversation),
          `Project: ${facts.project.name}`,
          `Path: ${facts.project.path}`,
          `First run: ${facts.firstRun}`,
          `Project setup undecided: ${facts.projectUndecided}`,
          `Git isolation: ${facts.gitReason ?? 'ready'}`,
          `Root: ${root}; empty: ${facts.rootEmpty}`,
          ...(instructions === undefined ? [] : [`User instructions:\n${instructions}`]),
        ].join('\n'),
        entry: {
          kind: StartEntry.kind,
          data: { root, ...(instructions === undefined ? {} : { instructions }), facts },
        },
        requestId: `onboarding:${root}`,
        whenBusy: 'followUp',
      },
      context,
    )
    await harness.commit(async (tx) => {
      ;(await tx.doc(Starts, ROOT_CONVERSATION_ID)).roots[String(root)] = id
    }, context)
    return { id }
  }),
  dismiss: implementAction(DismissAction, async (_args, { host }) => {
    await host.harness().commit(async (tx) => {
      ;(await tx.doc(Starts, ROOT_CONVERSATION_ID)).dismissed = true
    }, context)
    return { dismissed: true }
  }),
  walkthrough: implementAction(WalkthroughAction, async (_args, { host }) => {
    const id = await host.need(SubagentsApi).standing('ultimate', context)
    const conversation = (await host.harness().conversation(id, context))!
    await conversation.submit(
      {
        type: 'input',
        content: `Walkthrough started: run how-ultimate-works, without project setup.\n${await modelLine(host, conversation)}`,
        entry: { kind: WalkthroughEntry.kind, data: {} },
        whenBusy: 'followUp',
      },
      context,
    )
    return { id }
  }),
  choose: implementAction(ChooseAction, async (args, actionContext) => {
    const { host, conversationId } = actionContext
    if (conversationId === undefined) throw new Error('A conversation is required')
    if (
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      typeof args.toolCallId !== 'string' ||
      !args.toolCallId.trim()
    )
      throw new Error('Expected card and toolCallId')
    const { card, toolCallId } = args
    let payload: JsonObject
    let summary: string
    if (card === 'extensions') {
      const choices = args.extensions
      if (
        !choices ||
        typeof choices !== 'object' ||
        Array.isArray(choices) ||
        Object.entries(choices).some(
          ([name, enabled]) => !name.trim() || typeof enabled !== 'boolean',
        )
      )
        throw new Error('Expected extensions as names to booleans')
      const extensions = Object.fromEntries(
        Object.entries(choices).toSorted(([a], [b]) => a.localeCompare(b)),
      )
      payload = { card, extensions }
      const namesFor = (enabled: boolean) =>
        Object.keys(extensions)
          .filter((name) => extensions[name] === enabled)
          .join(', ') || 'none'
      summary = `enabled ${namesFor(true)}; disabled ${namesFor(false)}`
    } else if (card === 'project' && typeof args.local === 'boolean') {
      payload = { card, local: args.local }
      summary = args.local ? 'Using project setup' : 'Keeping global setup'
    } else if (card === 'git' && typeof args.initialize === 'boolean') {
      payload = { card, initialize: args.initialize }
      summary = args.initialize
        ? 'Git is ready'
        : 'Let @ultimate set up Git: write a project-appropriate .gitignore and make the first commit without secrets, dependencies, build output or generated files. Do not add a remote or push.'
    } else throw new Error('Expected extensions, project with local, or git with initialize')
    // Keep competing tabs serialized through settings reloads, including the gap before submit.
    const queue = host.resource('onboarding.choose', () => ({ tail: Promise.resolve() }))
    const operation = queue.tail.then(async () => {
      const harness = host.harness()
      const id = conversationId as ConversationId
      const requestId = `onboarding-choice:${toolCallId}`
      const existing = await harness.commit((tx) => tx.submissionByRequest(id, requestId), context)
      if (existing) {
        const saved = (await harness.snapshot(ChoiceRequests, id, context))?.payloads[toolCallId]
        if (JSON.stringify(saved) !== JSON.stringify(payload))
          throw new Error('This setup card already has a different choice')
      }
      const conversation = await harness.conversation(id, context)
      if (!conversation) throw new Error('Conversation not found')
      if (!existing) {
        if (card === 'extensions')
          await actions.applyFirstRun({ extensions: payload.extensions! }, actionContext)
        else if (card === 'project') await actions.decide({ local: payload.local! }, actionContext)
        else if (payload.initialize) await host.need(WorkspacesApi).setupGit()
        // Persist the payload before admission: queued submissions have no transcript entry yet.
        await harness.commit(async (tx) => {
          ;(await tx.doc(ChoiceRequests, id)).payloads[toolCallId] = payload
        }, context)
      }
      await conversation.submit(
        {
          type: 'input',
          content: `Setup choice (${card}): ${summary}`,
          entry: { kind: ChoiceEntry.kind, data: { card, summary, toolCallId } },
          requestId,
          whenBusy: 'followUp',
        },
        context,
      )
      return { sent: true }
    })
    queue.tail = operation.then(
      () => {},
      () => {
        // This caller receives its failure; the next choice must still be able to retry.
      },
    )
    return operation
  }),
  status: implementAction(StatusAction, async (_args, { host }) => {
    const folders = await host.projectExtensions()
    // `"onboarding": false` in the user's settings: an experienced machine skips the first run and Start here.
    const off = (await readSettings(userSettingsPath(host.userHome))).onboarding === false
    return {
      firstRun: !off && !existsSync(marker(host.userHome)),
      off,
      project: await host.projectSetup(),
      // The user's own lists, for the first run's checkboxes.
      user: await declared(userSettingsPath(host.userHome)),
      adds: {
        ...(await adds(host.projectRoot)),
        extensions: folders.filter((entry) => !entry.replaces).map((entry) => entry.name),
        replaces: folders.filter((entry) => entry.replaces).map((entry) => entry.name),
      },
    }
  }),
  firstRunDone: implementAction(FirstRunDoneAction, async (_args, { host }) => {
    await writeJson(marker(host.userHome), { firstRunDone: true })
    return { firstRun: false }
  }),
  /**
   * The first run's choices in one step: checked names join the user's `extensions.enable` (and leave `disable`),
   * unchecked names join `disable`; `local`, when given, is the project decision. Records the first run, then applies
   * it all with one reload.
   */
  applyFirstRun: async (args, { host }) => {
    const choices =
      args && typeof args === 'object' && !Array.isArray(args) ? args.extensions : undefined
    if (
      !choices ||
      typeof choices !== 'object' ||
      Array.isArray(choices) ||
      Object.entries(choices).some(
        ([name, enabled]) => !name.trim() || typeof enabled !== 'boolean',
      ) ||
      ((args as JsonObject).local !== undefined && typeof (args as JsonObject).local !== 'boolean')
    )
      throw new Error(
        'Expected extensions as non-empty names to booleans, and local as a boolean if given',
      )
    const { local } = args as { local?: boolean }
    await updateSettings(userSettingsPath(host.userHome), (value) => {
      const extensions = lists(value)
      for (const [name, enabled] of Object.entries(choices as Record<string, boolean>))
        toggle(extensions, name, enabled)
    })
    await writeJson(marker(host.userHome), { firstRunDone: true })
    if (local === undefined) await host.reloadExtensions()
    else await host.setProjectDecision(local)
    return { firstRun: false }
  },
  decide: implementAction(DecideAction, async (args, { host }) => {
    if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.local !== 'boolean')
      throw new Error('local must be a boolean')
    await host.setProjectDecision(args.local)
    return { project: await host.projectSetup() }
  }),
  setExtension: implementAction(SetExtensionAction, async (args, { host }) => {
    if (
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      typeof args.name !== 'string' ||
      !args.name.trim() ||
      typeof args.enabled !== 'boolean' ||
      (args.scope !== 'project' && args.scope !== 'user')
    )
      throw new Error('Expected name, enabled boolean, and scope project or user')
    if (args.scope === 'project' && (await host.projectSetup()).decision !== true)
      throw new Error("Choose this project's local setup before changing project extensions")
    const path = join(
      args.scope === 'project' ? host.projectRoot : host.userHome,
      '.ultimate/settings.json',
    )
    await updateSettings(path, (value) =>
      toggle(lists(value), args.name as string, args.enabled as boolean),
    )
    await host.reloadExtensions()
    return { ok: true }
  }),
  adoptProjectSetup: implementAction(AdoptProjectSetupAction, async (_args, { host }) => {
    if ((await host.projectSetup()).decision !== true)
      throw new Error("Choose this project's local setup before adopting project extensions")
    const project = lists(await host.projectSettings())
    if (
      !(project.enable as string[] | undefined)?.length &&
      !(project.disable as string[] | undefined)?.length
    )
      return { ok: true }
    const path = userSettingsPath(host.userHome)
    await updateSettings(path, (value) => {
      const extensions = lists(value)
      for (const [key, enabled] of [
        ['enable', true],
        ['disable', false],
      ] as const)
        for (const name of (project[key] as string[]) ?? []) toggle(extensions, name, enabled)
    })
    await host.reloadExtensions()
    return { ok: true }
  }),
  details: implementAction(DetailsAction, async (args, { host }) => {
    const name = args && typeof args === 'object' && !Array.isArray(args) ? args.name : undefined
    const folder = host.extensions().find((entry) => entry.name === name)
    if (typeof name !== 'string' || !folder)
      throw new Error(`Unknown extension ${JSON.stringify(name)}`)
    const { apis } = host.catalogue()
    const matching = (pick: (api: (typeof apis)[number]) => boolean) =>
      apis.filter(pick).map((api) => api.name)
    return {
      ...(await contractOutline(folder)),
      provides: matching((api) => api.provider === name),
      declares: matching((api) => api.owner === name && api.provider !== name),
      needs: matching((api) => api.needs.includes(name)),
      wants: matching((api) => api.wants.includes(name)),
    }
  }),
  extensions: implementAction(ExtensionsAction, async (_args, { host }) => {
    const project = await host.projectExtensions()
    return Promise.all(
      [
        ...host
          .extensions()
          .filter((entry) => !project.some((folder) => folder.name === entry.name)),
        ...project,
      ].map(async (entry) => {
        const readme = await readFile(join(entry.path, 'README.md'), 'utf8').catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
            return ''
          },
        )
        const paragraph =
          readme
            .replace(/^#+ .*\n+/u, '')
            .trim()
            .split(/\n\s*\n/u)[0] ?? ''
        return {
          name: entry.name,
          source: entry.source,
          ...(entry.replaces ? { replaces: entry.replaces } : {}),
          enabled: entry.enabled,
          layer: entry.layer,
          readme: paragraph.match(/^.*?[.!?](?:\s|$)/su)?.[0].trim() ?? paragraph,
        }
      }),
    )
  }),
}

export const ChoiceEntry = defineEntry<{ card: string; summary: string; toolCallId: string }>(
  'onboarding.choice',
)

export default function onboarding(host: ExtensionHost) {
  // Core, always on; resolved where they are called, declared here so the catalogue lists them.
  host.need(LineageApi)
  host.need(SubagentsApi)
  host.need(WorkspacesApi)
  return defineExtension({
    name: 'onboarding',
    tools: [
      defineTool({
        name: 'setup',
        deferred: true,
        description:
          'Show an inline setup card for the user to choose. Wait for the onboarding.choice input; only the user can apply choices.',
        parameters: obj({
          card: oneOf(['extensions', 'project', 'git']),
        }),
        // Read-only inspection: repeating a card changes no state.
        replay: 'safe',
        async execute({ card }) {
          const project = await host.projectSetup()
          if (card === 'project' && (!project.config || project.decision !== null))
            throw new Error(
              !project.config
                ? 'This project has no .ultimate/ setup'
                : 'Project setup is already decided',
            )
          const checkout = card === 'git' ? await isolatable(host.projectRoot) : undefined
          if (checkout && !('reason' in checkout))
            throw new Error('This folder is already isolatable')
          const text =
            card === 'git' && checkout && 'reason' in checkout
              ? checkout.reason
              : card === 'project'
                ? `Project has a .ultimate/ setup; undecided. ${JSON.stringify(await adds(host.projectRoot))}`
                : 'Choose recommended extensions. Settings apply only when the user continues.'
          return { output: [{ type: 'text', text }] }
        },
      }),
    ],
  })
}
