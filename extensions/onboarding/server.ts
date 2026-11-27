import type {
  Conversation,
  ConversationId,
  Cursor,
  EntryId,
  Tx,
  JsonObject,
} from '@earendil-works/pi-durable'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { loadSkillsFromDir, parseFrontmatter } from '@earendil-works/pi-coding-agent'
import {
  defineDoc,
  defineExtension,
  defineTool,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import { obj } from '@earendil-works/pi-schema'
import { strEnum } from '../../lib/schema.ts'
import { meansNone, settled } from '../../lib/errors.shared.ts'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { ExtensionHost } from '../../server/extensions.ts'
import { isolatable } from '../../lib/git.ts'
import { writeJson } from '../../lib/json-file.ts'
import { providerKeyStandsIn } from '../../lib/openai.ts'
import { secretMetadata } from '../../lib/secrets.ts'
import {
  extensionLists,
  readSettings,
  toggleExtension,
  updateSettings,
  userSettingsPath,
} from '../../lib/settings.ts'
import type { ExtensionAction } from '../../server/actions.ts'
import { SubagentsApi } from '../subagents/api.ts'
import { LineageApi } from '../lineage/api.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import { implementAction } from '../../lib/actions.ts'
import {
  ChooseAction,
  DismissAction,
  FirstRunDoneAction,
  HelpAction,
  StartAction,
  StartsDoc,
  StatusAction,
  WalkthroughAction,
} from './refs.ts'
import { StartEntry, WalkthroughEntry, ChoiceEntry } from './entries.shared.ts'
import { safeToRerun } from '../../lib/replay.ts'
import { checkpointEvery } from '../../shared/checkpoint.ts'

export const Starts = defineDoc<{ roots: Record<string, ConversationId>; dismissed?: boolean }>({
  kind: StartsDoc.kind,
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ roots: {} }),
})
const ChoiceRequests = defineDoc<{ payloads: Record<string, JsonObject> }>({
  kind: 'onboarding.choice-requests',
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ payloads: {} }),
})
export const docs = [Starts]

async function missingSecrets(host: ExtensionHost, chosen: Record<string, boolean>) {
  const declared = host
    .extensions()
    .filter((extension) => chosen[extension.name] && extension.enabled)
    .flatMap((extension) => extension.server?.secrets ?? [])
    .filter(
      ({ name, provider }) =>
        !process.env[name] && !(provider && providerKeyStandsIn(host.modelRuntime, provider)),
    )
  if (!declared.length) return []
  const stored = new Set((await secretMetadata(host.userHome)).map((secret) => secret.name))
  return [...new Set(declared.map(({ name }) => name))]
    .filter((name) => !stored.has(name))
    .toSorted()
}
async function inspectResourceNames(projectRoot: string) {
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
        const definition = await readFile(join(directory, file), 'utf8')
          .then((text) => parseFrontmatter(text))
          .catch(meansNone)
        const name = definition?.frontmatter.name
        return typeof name === 'string' && name.trim() ? name.trim() : basename(file, '.md')
      }),
  )
  const skills = loadSkillsFromDir({
    dir: join(projectRoot, '.ultimate/skills'),
    source: 'project',
  })
    .skills.map((skill) => skill.name)
    .toSorted()
  return {
    agents,
    skills,
    ...(await declaredExtensionChoices(join(projectRoot, '.ultimate/settings.json'))),
  }
}

const names = (value: unknown) =>
  Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : []

async function declaredExtensionChoices(path: string) {
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

async function answeredSuccessfullySince(tx: Tx, conversationId: ConversationId, from: EntryId) {
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanEntries(
      { conversationId, minEntryId: from, order: 'ascending' },
      100,
      cursor,
    )
    if (
      page.items.some((entry) => {
        const message = entry.model?.[0]
        return (
          message?.role === 'assistant' &&
          message.stopReason !== 'error' &&
          message.stopReason !== 'aborted'
        )
      })
    )
      return true
    cursor = page.next
  } while (cursor)
  return false
}

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
    const input = args as { root?: ConversationId; instructions?: string } | null
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
      ROOT_CONVERSATION_ID
    const harness = host.harness()
    const requestId = `onboarding:${root}`
    const existing = (await harness.snapshot(Starts, ROOT_CONVERSATION_ID, context))?.roots[
      String(root)
    ]
    if (existing !== undefined) {
      const conversation = (await harness.conversation(existing, context))!
      await harness.commit(async (tx) => {
        const sent = await tx.submissionByRequest(conversation.id, requestId)
        const { run, runFailure } = await tx.doc(LiveDoc, conversation.id)
        if (
          sent?.status !== 'unanswered' ||
          sent.entry === undefined ||
          run !== undefined ||
          !['no_model', 'model_error'].includes(runFailure?.reason ?? '') ||
          (await answeredSuccessfullySince(tx, conversation.id, sent.entry))
        )
          return
        await conversation.submit(tx, { type: 'continue' })
      }, context)
      return { id: existing }
    }
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
        async (tx) => !(await tx.scanEntries({ conversationId: root }, 1)).items.length,
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
        requestId,
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
    let missing: string[] = []
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
    const sharedChoiceQueue = host.resource('onboarding.choose', () => ({
      tail: Promise.resolve(),
    }))
    const operation = sharedChoiceQueue.tail.then(async () => {
      const harness = host.harness()
      const id = conversationId
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
        if (card === 'extensions') {
          await actions.applyFirstRun({ extensions: payload.extensions! }, actionContext)
          missing = await missingSecrets(host, payload.extensions as Record<string, boolean>)
        } else if (card === 'project') await host.setProjectDecision(payload.local === true)
        else if (payload.initialize) await host.need(WorkspacesApi).setupGit()
        await harness.commit(async (tx) => {
          ;(await tx.doc(ChoiceRequests, id)).payloads[toolCallId] = payload
        }, context)
      }
      await conversation.submit(
        {
          type: 'input',
          content: `Setup choice (${card}): ${summary}${missing.length ? `\nMissing keys: ${missing.join(', ')}. Ask the user in one line to add them with the Add buttons on this card.` : ''}`,
          entry: {
            kind: ChoiceEntry.kind,
            data: { card, summary, toolCallId, ...(missing.length ? { missing } : {}) },
          },
          requestId,
          whenBusy: 'followUp',
        },
        context,
      )
      return { sent: true }
    })
    sharedChoiceQueue.tail = settled(operation)
    return operation
  }),
  status: implementAction(StatusAction, async (_args, { host }) => {
    const folders = await host.projectExtensions()
    const off = (await readSettings(userSettingsPath(host.userHome))).onboarding === false
    return {
      firstRun: !off && !existsSync(marker(host.userHome)),
      off,
      project: await host.projectSetup(),
      user: await declaredExtensionChoices(userSettingsPath(host.userHome)),
      adds: {
        ...(await inspectResourceNames(host.projectRoot)),
        extensions: folders.filter((entry) => !entry.replaces).map((entry) => entry.name),
        replaces: folders.filter((entry) => entry.replaces).map((entry) => entry.name),
      },
    }
  }),
  firstRunDone: implementAction(FirstRunDoneAction, async (_args, { host }) => {
    await writeJson(marker(host.userHome), { firstRunDone: true })
    return { firstRun: false }
  }),
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
      const extensions = extensionLists(value)
      for (const [name, enabled] of Object.entries(choices as Record<string, boolean>))
        toggleExtension(extensions, name, enabled)
    })
    await writeJson(marker(host.userHome), { firstRunDone: true })
    if (local === undefined) await host.reloadExtensions()
    else await host.setProjectDecision(local)
    return { firstRun: false }
  },
}

export default function onboarding(host: ExtensionHost) {
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
          card: strEnum(['extensions', 'project', 'git']),
        }),
        ...safeToRerun(
          'a rerun shows the same card again; reading the trust decision only creates its lock file',
        ),
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
                ? `Project has a .ultimate/ setup; undecided. ${JSON.stringify(await inspectResourceNames(host.projectRoot))}`
                : 'Choose recommended extensions. Settings apply only when the user continues.'
          return { output: [{ type: 'text', text }] }
        },
      }),
    ],
  })
}
