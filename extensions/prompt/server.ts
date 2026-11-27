import { parseConversationId } from '../../lib/ids.shared.ts'
import type { Context } from '@earendil-works/chord/context'
import type { ConversationId, PromptInput, Tx } from '@earendil-works/pi-durable'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { formatSkillsForPrompt, loadProjectContextFiles } from '@earendil-works/pi-coding-agent'
import {
  AgentDoc,
  configure,
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
  section,
} from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { ConversationSummary } from '../../shared/protocol.ts'
import { cachedDiscovery, discoverAgents } from '../../lib/agents.ts'
import { git, refFiles } from '../../lib/git.ts'
import { fileMemo } from '../../lib/memo.ts'
import { ignoring, isMissing, meansNone } from '../../lib/errors.shared.ts'
import { shortTitle } from '../../lib/title.ts'
import { Profile, Standing } from '../subagents/api.ts'
import type { BuildNote, Landing } from './refs.ts'
import { checkpointEvery } from '../../shared/checkpoint.ts'

export const order = -100

const LastRunBuildAndInstructionHashes = defineDoc<{
  id?: string
  head?: string
  files?: Record<string, string>
}>({
  kind: 'prompt.build',
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  initial: () => ({}),
})
export const docs = [LastRunBuildAndInstructionHashes]

export function buildNote(
  build: ReturnType<ExtensionHost['build']>,
  seen: string,
  landed: Landing[] = [],
) {
  const since = build.history.findIndex((entry) => entry.id === seen)
  const changed =
    since < 0 ? [] : [...new Set(build.history.slice(since + 1).flatMap((entry) => entry.changed))]
  return (
    `Build changed: ${seen} → ${build.id} · generation ${build.generation}` +
    (changed.length ? ` · changed: ${changed.join(', ')}` : '') +
    (landed.length
      ? ` · landed: ${landed.map((row) => (row.conversation ? `${row.title} (#${row.conversation})` : `${row.title} (${row.sha.slice(0, 7)})`)).join(', ')}`
      : '')
  )
}

export async function landings(
  cwd: string,
  from: string,
  to: string,
  conversations: ConversationSummary[],
): Promise<Landing[]> {
  const log = await git(
    cwd,
    'log',
    '--first-parent',
    '-n',
    '200',
    '--format=%H%x00%s%x00%(trailers:key=Ultimate-Conversation,valueonly)%x1e',
    `${from}..${to}`,
  )
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]))
  const rows = new Map<string, Landing>()
  for (const record of log.split('\x1e')) {
    const [sha, subject, trailer] = record.trim().split('\0')
    if (!sha) continue
    let id =
      parseConversationId(
        Number(trailer?.trim()) || Number(/ from #(\d+) into /.exec(subject)?.[1]),
      ) || undefined
    for (let owner = id && byId.get(id)?.parentConversationId; owner;) {
      id = owner
      owner = byId.get(owner)?.parentConversationId
    }
    const key = id ? `#${id}` : sha
    if (rows.has(key)) continue
    const title = id && byId.get(id)?.title
    rows.set(key, {
      ...(id ? { conversation: id } : {}),
      title: title ? shortTitle(title) : subject,
      sha,
    })
  }
  return [...rows.values()]
}

const noLandingsFromUnavailableHistory = () => []

const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)

async function cloneInstructionPaths(host: ExtensionHost) {
  const markdownPathsOrNone = async (folder: string) =>
    (await readdir(join(host.ultimateRoot, folder)).catch(() => [] as string[]))
      .filter((name) => name.endsWith('.md'))
      .map((name) => join(host.ultimateRoot, folder, name))
  return [
    join(host.ultimateRoot, 'AGENTS.md'),
    ...(await markdownPathsOrNone('docs')),
    ...(await markdownPathsOrNone('agents')),
  ]
}

const projectContext = (host: ExtensionHost) =>
  loadProjectContextFiles({ cwd: host.projectRoot, agentDir: join(host.userHome, '.ultimate') })

async function instructionPaths(host: ExtensionHost, own: readonly string[]) {
  const contextFolders = []
  for (let folder = host.projectRoot; ; folder = dirname(folder)) {
    contextFolders.push(folder)
    if (dirname(folder) === folder) break
  }
  return [
    join(host.ultimateRoot, 'docs'),
    join(host.ultimateRoot, 'agents'),
    join(host.userHome, '.ultimate'),
    ...contextFolders,
    ...(await cloneInstructionPaths(host)),
    ...projectContext(host).map((file) => file.path),
    ...own,
  ]
}

async function instructionHashes(host: ExtensionHost, own: readonly string[]) {
  const hashesByAbsolutePath: Record<string, string> = {}
  for (const path of await cloneInstructionPaths(host)) {
    const text = await readFile(path, 'utf8').catch(ignoring(isMissing))
    if (text !== undefined) hashesByAbsolutePath[path] = digest(text)
  }
  for (const file of projectContext(host)) hashesByAbsolutePath[file.path] = digest(file.content)
  const removedFileText = () => ''
  for (const path of own)
    hashesByAbsolutePath[path] = digest(await readFile(path, 'utf8').catch(removedFileText))
  return hashesByAbsolutePath
}

function instructionReads(host: ExtensionHost) {
  const discovered = cachedDiscovery(
    host.ultimateRoot,
    host.projectRoot,
    host.userHome,
    host.modelRuntime,
  )
  let own: readonly string[] = []
  const files = fileMemo({
    paths: () => instructionPaths(host, own),
    read: () => instructionHashes(host, own),
    key: () => own.join('\0'),
  })
  return async () => {
    const definition = (await discovered()).definitions.find(
      (candidate) => candidate.name === 'ultimate',
    )
    own = definition ? [definition.path, ...(definition.overlays ?? [])] : []
    return { definition, files: await files() }
  }
}
type InstructionReads = Awaited<ReturnType<ReturnType<typeof instructionReads>>>

function shown(host: ExtensionHost, path: string) {
  const inProject = relative(host.projectRoot, path)
  if (!inProject.startsWith('..')) return inProject
  const inClone = relative(host.ultimateRoot, path)
  if (!inClone.startsWith('..')) return `Ultimate/${inClone}`
  return path.startsWith(host.userHome) ? `~${path.slice(host.userHome.length)}` : path
}

async function instructionChanges(
  host: ExtensionHost,
  tx: Tx,
  conversationId: ConversationId,
  seen: { files?: Record<string, string> },
  { definition, files: hashesByAbsolutePath }: InstructionReads,
) {
  const name = 'ultimate'
  const definitionDiffersFromConversation =
    definition !== undefined &&
    (await tx.doc(AgentDoc, conversationId)).instructions !== definition.instructions
  if (definitionDiffersFromConversation)
    await configure(tx, conversationId, { instructions: definition.instructions })
  const own = definition ? [definition.path, ...(definition.overlays ?? [])] : []
  const previous = seen.files
  seen.files = hashesByAbsolutePath
  const changed = previous
    ? [...new Set([...Object.keys(previous), ...Object.keys(hashesByAbsolutePath)])]
        .filter((path) => previous[path] !== hashesByAbsolutePath[path])
        .toSorted()
    : []
  const ownFile = `/agents/${name}.md`
  const touched = changed.filter((path) => own.includes(path) || path.endsWith(ownFile))
  const changedOrReappliedDefinitionPaths =
    touched.length || !definitionDiffersFromConversation ? touched : own.slice(0, 1)
  const instructions = changedOrReappliedDefinitionPaths.map((path) =>
    path in hashesByAbsolutePath ? shown(host, path) : `${shown(host, path)} (removed)`,
  )
  const named = changed
    .filter((path) => !touched.includes(path))
    .map((path) =>
      path in hashesByAbsolutePath ? shown(host, path) : `${shown(host, path)} (removed)`,
    )
  return { instructions, docs: named }
}

export function instructionNote(changes: { instructions: string[]; docs: string[] }) {
  return [
    changes.instructions.length > 0 &&
      `Instructions changed: ${changes.instructions.join(', ')}. Your system prompt now carries the new text; drop habits from the old one.`,
    changes.docs.length > 0 &&
      `Docs changed: ${changes.docs.join(', ')}. Re-read them before relying on what you read earlier.`,
  ]
    .filter(Boolean)
    .join('\n')
}

async function definitionSkills(
  host: ExtensionHost,
  input: PromptInput,
  context: Context,
): Promise<string[] | undefined> {
  const profile = await input.read.snapshot(Profile, input.conversationId, context)
  if (profile?.adhoc) return undefined
  const name =
    profile?.definition ??
    (await input.read.snapshot(host.metadata, input.conversationId, context))?.label
  if (!name) return undefined
  const { definitions } = await discoverAgents(
    host.ultimateRoot,
    host.projectRoot,
    host.userHome,
    host.modelRuntime,
  )
  return definitions.find((definition) => definition.name === name)?.skills
}

export default function prompt(host: ExtensionHost) {
  const instructions = instructionReads(host)
  const cloneHead = fileMemo({
    paths: () => refFiles(host.ultimateRoot).catch((): string[] => []),
    read: () => git(host.ultimateRoot, 'rev-parse', 'HEAD').catch(meansNone),
  })
  const landedByRange = new Map<string, Promise<Landing[]>>()
  const landedBetween = (from: string, to: string) => {
    const range = `${from}..${to}`
    if (!landedByRange.has(range)) {
      if (landedByRange.size >= 8) landedByRange.delete(landedByRange.keys().next().value!)
      landedByRange.set(
        range,
        landings(host.ultimateRoot, from, to, host.conversations()).catch(
          noLandingsFromUnavailableHistory,
        ),
      )
    }
    return landedByRange.get(range)!
  }
  return defineExtension({
    name: 'prompt',
    hooks: [
      // Pi upstream: @earendil-works/pi-durable@1.6.0 — patched transactional beforeInput hook.
      hook(GenerationTask, {
        prepareInput: async ({ conversationId }, ctx) => {
          const harness = host.harness()
          if (
            (await harness.snapshot(Standing, ROOT_CONVERSATION_ID, ctx))?.ultimate ===
            conversationId
          )
            await instructions()
          const head = await cloneHead()
          const from = (
            await harness.snapshot(LastRunBuildAndInstructionHashes, conversationId, ctx)
          )?.head
          if (head && from && head !== from) await landedBetween(from, head)
        },
        beforeInput: async function cachePreservingInputNote(_input, { tx, conversationId }) {
          const build = host.build()
          const seen = await tx.doc(LastRunBuildAndInstructionHashes, conversationId)
          const ultimate =
            (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate === conversationId
          const changes = ultimate
            ? await instructionChanges(host, tx, conversationId, seen, await instructions())
            : { instructions: [], docs: [] }
          const previous = seen.id
          seen.id = build.id
          const built = previous !== undefined && previous !== build.id
          let landed: Landing[] = []
          if (seen.head === undefined || built) {
            const head = await cloneHead()
            if (built && head && seen.head && head !== seen.head)
              landed = await landedBetween(seen.head, head)
            if (head) seen.head = head
          }
          const text = [built && buildNote(build, previous, landed), instructionNote(changes)]
            .filter(Boolean)
            .join('\n')
          if (!text) return undefined
          const data: BuildNote = {
            ...(built && { from: previous, to: build.id }),
            ...(landed.length > 0 && { landed }),
            ...(changes.instructions.length > 0 && { instructions: changes.instructions }),
            ...(changes.docs.length > 0 && { docs: changes.docs }),
          }
          return {
            entries: [
              {
                kind: 'prompt.build',
                data: { ...data },
                model: [{ role: 'user' as const, content: text, timestamp: Date.now() }],
              },
            ],
          }
        },
      }),
    ],
    sections: [
      section(
        'identity',
        (input) =>
          `You are Ultimate, a coding agent running in a web UI on the user's machine. The person in this conversation steers; you build, verify, and report. You are meant to be specialized for the project: build the tools, panels, agents, and skills that help with it into ${input.env?.cwd ?? input.agent.cwd ?? host.projectRoot}/.ultimate/ so everyone working on the project gets them, and personal ones into ~/.ultimate/.`,
      ),
      section(
        'principles',
        () => `- Read what kind of request it is. A question, or "how could we…", asks you to explore: investigate, then come back with one proposal that includes what the person may not have thought of (a risk, a simpler path, a case it also touches), and wait for their go before changing anything. A clear instruction ("do this", "fix that"), a delegated task or a scheduled run is the go, unless it asks for an assessment first: do it, verify, and report, asking only about decisions that change behaviour or scope. When you need a decision from the person, ask it the way your instructions say.
- Understand before you change: read the relevant code, run it, look at it. Ground every claim in files, command output, tests, or screenshots.
- Keep it simple: question the need, reuse what exists, prefer platform features and installed dependencies, and write the least code that solves the actual problem. No speculative abstractions, compatibility shims, or fallbacks for situations that do not exist.
- Fail fast, iterate quickly, verify by trying: make a small change, run it, check the result in tests, the running app, or a screenshot, then take the next step.
- Never claim success you have not verified. When a check fails, say so and show the output. When you skipped something, say that.
- Taste matters. Code reads like the code around it; UI is clean, consistent, and quiet. Leave things better than you found them, within the scope you were asked for.
- Think about how it is experienced, not just whether it works. Before building or delegating anything a person sees, look at how the app presents similar things today (take screenshots, open older ones, read neighbouring renderers) and design the new thing to match: an outcome the user waits for gets a clear, distinct card, never raw text in a plain message. Connect what you learn: a pattern the user corrected once applies to every similar case, without being asked again.
- Be concise and direct. Surface the risks and tradeoffs that matter, and recommend one option instead of listing them all.`,
      ),
      section('self_awareness', (input) => {
        const tools = input.agent.tools ?? []
        const has = (name: string) => tools.some((tool) => tool.name === name)
        return [
          'You are an agent: a model in a loop that calls tools inside a durable harness. Know your own mechanics:',
          '- This is one long-running conversation, not a fresh session per task. Compaction keeps it going; earlier work is part of your history.',
          '- Your context window is finite. When it fills up, older turns are summarized by compaction and you see a summary instead; the full history stays in storage.' +
            (has('codemode') ? ' Search it with `ultimate.search()` in codemode.' : ''),
          '- Messages can arrive while you work: a steering message joins your current run after the current tool round; a follow-up starts your next run. Take them into account immediately. Inputs still queued in `pi.inbox` are not delivered yet: do not act on them early, or they arrive again after you handled them.',
          '- Every step you take is a durable task. If the process restarts or crashes, your run resumes from its last checkpoint. A tool that reports "interrupted" may or may not have finished: check before retrying.',
          ...(has('subagent')
            ? [
                '- Subagents are separate conversations with their own context. Give them self-contained tasks.',
              ]
            : []),
          '- When a "Build changed" note arrives with your input, you were hot-swapped: your tools, prompt, or UI may be different now. Find out what changed (the changed list, `git log`/`git diff`' +
            (has('codemode') ? ', `ultimate.extensions()`' : '') +
            ') and test new behaviour before relying on it. An "Instructions changed" or "Docs changed" line means those files changed: your system prompt already carries changed instructions; re-read changed docs before relying on them.',
        ].join('\n')
      }),
      // Pi upstream: @earendil-works/pi-coding-agent@1.6.0 src/core/system-prompt.ts and src/core/tools/*.ts — copied tool guidance adapted from unexported prompt contributions. Drop when Pi exports buildSystemPromptSections and the per-tool system prompt contributions.
      section('tools', (input) => {
        const guidance: Record<string, string> = {
          read: '- read: inspect files, with offset/limit for large files.',
          bash: "- bash: run commands, tests, builds, git, and searches (rg, find, ls). Each call starts in your work checkout, so commands can use paths relative to it. Long output is truncated; the full output is saved to a file you can read. To wait or poll (CI, deploys, a server or file appearing), use interruptible: true so a steering message ends it early; keep each sleep at 30 s or less per check, and never wait in the same call as a command that changes things. Start servers and other long-running processes with background: true and stop them with the kill command it returns; never stop a process you did not start, and never find one by name or port (pkill, fuser -k, lsof, ss): that kills other branches' servers or Ultimate itself.",
          edit: '- edit: change existing files with precise replacements. Each edits[].oldText must match the file exactly and be unique; keep it small. Put several changes to one file into one call; edits are matched against the original file, so never overlap them. After "Could not find", read the region again before retrying; after "Found N occurrences", widen oldText with surrounding lines.',
          write: '- write: create new files or rewrite one completely.',
        }
        const names = new Set((input.agent.tools ?? []).map((tool) => tool.name))
        return [
          ...[...names].flatMap((name) => (guidance[name] ? [guidance[name]] : [])),
          ...(names.has('bash') && names.has('read') && names.has('edit') && names.has('write')
            ? [
                '- IMPORTANT: never use bash to read or change files when a dedicated tool does it. Read with read, not cat, head, tail or sed -n. Change files with edit, not sed -i, perl, awk or a python or node script. Create files with write, not a heredoc, echo or printf redirect. The person reviews your work through these tools: edit and write show each change as a diff, a script in bash hides it, and edit refuses text that does not match exactly once where a script silently changes nothing. A rename across a few files is one edit call per file. Only output a program generates (formatters, codegen, package managers) or a mechanical change across many files goes through bash.',
              ]
            : []),
          '- You talk to the person through a web UI that renders Markdown: short paragraphs, lists, fenced code with a language, and file paths in backticks.',
        ].join('\n')
      }),
      section('project_context', (input) =>
        loadProjectContextFiles({
          cwd: input.env?.cwd ?? input.agent.cwd ?? host.projectRoot,
          agentDir: join(host.userHome, '.ultimate'),
        })
          .map(
            (file) =>
              `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`,
          )
          .join('\n\n'),
      ),
      section('skills', async (input, context) => {
        const names = new Set((input.agent.tools ?? []).map((tool) => tool.name))
        const reader = (['read', 'bash'] as const).find((name) => names.has(name))
        if (!reader) return undefined
        const skills = host.skills(input.env?.cwd ?? input.agent.cwd ?? host.projectRoot)
        const allowed = await definitionSkills(host, input, context)
        const listed = formatSkillsForPrompt(
          allowed ? skills.filter((skill) => allowed.includes(skill.name)) : skills,
          reader,
        ).trim()
        return listed
          ? `${listed}\nWhen a task matches a listed skill, read it before you start; it carries the steps the project expects.`
          : undefined
      }),
      section(
        'building_blocks',
        () => {
          const off = host.extensions().filter((extension) => !extension.enabled)
          const emptySectionPreservingPromptOrder = ''
          if (!off.length) return emptySectionPreservingPromptOrder
          return [
            '<building_blocks>',
            `Available but off building blocks live in ${host.ultimateRoot}/extensions/:`,
            ...off.map((extension) => {
              const sentence = extension.readme
                ?.trim()
                .split(/(?<=[.!?])\s/)[0]
                ?.replace(/\s+/g, ' ')
              return `- ${extension.name}: ${sentence ?? ''}`
            }),
            'Enable names with "extensions": { "enable": [...] } in ~/.ultimate/settings.json (this machine) or <project>/.ultimate/settings.json (the host project). Changes apply live with no restart.',
            `The running host uses ${host.projectRoot}/.ultimate/settings.json and ${host.projectRoot}/.ultimate/extensions/; editing these in a separate work checkout does not change the host's configuration or hot-reload its extensions.`,
            '</building_blocks>',
          ].join('\n')
        },
        { tag: false },
      ),
      section('environment', (input) => {
        const cwd = input.env?.cwd ?? input.agent.cwd ?? host.projectRoot
        const os = process.platform === 'darwin' ? 'macOS' : process.platform
        return `OS: ${os} ${process.arch}\nWork checkout (effective cwd): ${cwd}\nHost project: ${host.projectRoot}\nRunning Ultimate host: ${host.ultimateRoot}\nUI: ${host.system().process.url} (shared host)\nDirect project edits to the effective cwd. Host-scoped config and extensions remain loaded from the host project and Ultimate clone; edits in a separate checkout do not hot-reload the running host.`
      }),
      section('cwd', (input) => input.env?.cwd ?? input.agent.cwd ?? host.projectRoot),
    ],
  })
}
