import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
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
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { ConversationSummary } from '../../shared/protocol.ts'
import { discoverAgents } from '../../lib/agents.ts'
import { git } from '../../lib/git.ts'
import { shortTitle } from '../../lib/title.ts'
import { Standing } from '../subagents/api.ts'
import type { BuildNote, Landing } from './refs.ts'

export const order = -100

/**
 * The build a conversation's last run started on and the clone's commit then (`head`); a fork starts from its parent's.
 * For the primary agent also the hashes of the instruction files it last saw (`files`, path → sha256 prefix).
 */
const SeenBuild = defineDoc<{ id?: string; head?: string; files?: Record<string, string> }>({
  kind: 'prompt.build',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  initial: () => ({}),
})
export const docs = [SeenBuild]

/**
 * What changed since build `seen`: the changes of every later build in this process, or nothing when it is older, and
 * what landed meanwhile.
 */
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

/**
 * The landings in the clone from commit `from` to `to`, newest first: one row per branch, named by its title, else by
 * its newest commit's subject. A commit names its conversation by trailer, a lander merge in its subject; a
 * subagent's commit counts for the branch that owns it. A commit made outside Ultimate is a row of its own.
 */
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
    let id = Number(trailer?.trim()) || Number(/ from #(\d+) into /.exec(subject)?.[1]) || undefined
    // An owned conversation (a worker, a designer) worked for its owner's branch.
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

const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)

/** Ultimate's own docs the primary agent reads on demand, by absolute path: `AGENTS.md`, `docs/*.md`, `agents/*.md`. */
async function cloneDocs(ultimateRoot: string, files: Record<string, string>) {
  const listed = async (folder: string) =>
    // A missing folder lists nothing.
    (await readdir(join(ultimateRoot, folder)).catch(() => [] as string[]))
      .filter((name) => name.endsWith('.md'))
      .map((name) => join(ultimateRoot, folder, name))
  const paths = [
    join(ultimateRoot, 'AGENTS.md'),
    ...(await listed('docs')),
    ...(await listed('agents')),
  ]
  for (const path of paths) {
    // A doc removed between the listing and the read is simply not there.
    const text = await readFile(path, 'utf8').catch(() => undefined)
    if (text !== undefined) files[path] = digest(text)
  }
}

/**
 * `path` as the agent knows it: relative to the project, or to the clone (`Ultimate/…` when the clone is another
 * folder), else with the home as `~`.
 */
function shown(host: ExtensionHost, path: string) {
  const inProject = relative(host.projectRoot, path)
  if (!inProject.startsWith('..')) return inProject
  const inClone = relative(host.ultimateRoot, path)
  if (!inClone.startsWith('..')) return `Ultimate/${inClone}`
  return path.startsWith(host.userHome) ? `~${path.slice(host.userHome.length)}` : path
}

/**
 * For the primary agent (@ultimate): re-apply its definition's instructions when they
 * differ from the conversation's, and name the instruction files that changed since its last run. Other agents keep
 * the instructions they started with.
 */
async function instructionChanges(
  host: ExtensionHost,
  tx: Tx,
  conversationId: ConversationId,
  seen: { files?: Record<string, string> },
) {
  const name = 'ultimate'
  if ((await tx.doc(Standing, ROOT_CONVERSATION_ID))[name] !== conversationId)
    return { instructions: [], docs: [] }
  const { definitions } = await discoverAgents(
    host.ultimateRoot,
    host.projectRoot,
    host.userHome,
    host.modelRuntime,
  )
  const definition = definitions.find((candidate) => candidate.name === name)
  // Messages deliveries refresh a standing agent; a typed input did not, so an updated definition waited for a message.
  const reapplied =
    definition !== undefined &&
    (await tx.doc(AgentDoc, conversationId)).instructions !== definition.instructions
  if (reapplied) await configure(tx, conversationId, { instructions: definition.instructions })
  // Keyed by absolute path, so the project's and the clone's AGENTS.md stay apart (and are one file when the clone is
  // the project).
  const files: Record<string, string> = {}
  await cloneDocs(host.ultimateRoot, files)
  for (const file of loadProjectContextFiles({
    cwd: host.projectRoot,
    agentDir: join(host.userHome, '.ultimate'),
  }))
    files[file.path] = digest(file.content)
  // The file was just parsed; one removed since then hashes as empty and counts as changed.
  const own = definition ? [definition.path, ...(definition.overlays ?? [])] : []
  for (const path of own) files[path] = digest(await readFile(path, 'utf8').catch(() => ''))
  const previous = seen.files
  seen.files = files
  // The first run records what it saw; afterwards every added, changed or removed file counts.
  const changed = previous
    ? [...new Set([...Object.keys(previous), ...Object.keys(files)])]
        .filter((path) => previous[path] !== files[path])
        .toSorted()
    : []
  // The definition's files (its own and any overlays) are named as instructions when they changed; a text re-applied
  // here with no file changed since the last run (a Messages delivery applied it already) names the definition's own
  // file. An overlay removed since the last run is found by its file name.
  const ownFile = `/agents/${name}.md`
  const touched = changed.filter((path) => own.includes(path) || path.endsWith(ownFile))
  const instructions = (touched.length || !reapplied ? touched : own.slice(0, 1)).map((path) =>
    path in files ? shown(host, path) : `${shown(host, path)} (removed)`,
  )
  const named = changed
    .filter((path) => !touched.includes(path))
    .map((path) => (path in files ? shown(host, path) : `${shown(host, path)} (removed)`))
  return { instructions, docs: named }
}

/** The note's text: what changed, so the agent knows its instructions or Ultimate's docs moved. */
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

export default function prompt(host: ExtensionHost) {
  return defineExtension({
    name: 'prompt',
    hooks: [
      // Pi upstream: @earendil-works/pi-durable@1.4.0 — patched transactional beforeInput hook.
      // The build is a note on the input that starts a run, not a system-prompt section: every hot reload changed that
      // section, and a changed system prompt rewrites the whole prompt cache. A conversation's first run records it.
      hook(GenerationTask, {
        beforeInput: async (_input, { tx, conversationId }) => {
          const build = host.build()
          const seen = await tx.doc(SeenBuild, conversationId)
          const changes = await instructionChanges(host, tx, conversationId, seen)
          const previous = seen.id
          seen.id = build.id
          const built = previous !== undefined && previous !== build.id
          let landed: Landing[] = []
          if (seen.head === undefined || built) {
            // Outside Git the build changes without commits: no landings to name.
            const head = await git(host.ultimateRoot, 'rev-parse', 'HEAD').catch(() => undefined)
            if (built && head && seen.head && head !== seen.head)
              landed = await landings(
                host.ultimateRoot,
                seen.head,
                head,
                host.conversations(),
              ).catch(
                // A seen commit no longer in the clone (history rewritten) names nothing.
                () => [],
              )
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
      // Pi upstream: @earendil-works/pi-coding-agent@1.4.0 src/core/system-prompt.ts and src/core/tools/*.ts — copied tool guidance adapted from unexported prompt contributions. Drop when Pi exports buildSystemPromptSections and the per-tool system prompt contributions.
      section('tools', (input) => {
        const guidance: Record<string, string> = {
          read: '- read: inspect files, with offset/limit for large files.',
          bash: '- bash: run commands, tests, builds, git, and searches (rg, find, ls). Long output is truncated; the full output is saved to a file you can read. To wait or poll (CI, deploys, a server or file appearing), use interruptible: true so a steering message ends it early; keep each sleep at 30 s or less per check, and never wait in the same call as a command that changes things.',
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
      section('skills', (input) => {
        const skills = host.skills(input.env?.cwd ?? input.agent.cwd ?? host.projectRoot)
        // As Pi's buildSystemPromptSections: name the tool the agent can load a skill with, and list none without one.
        const names = new Set((input.agent.tools ?? []).map((tool) => tool.name))
        const reader = (['read', 'bash'] as const).find((name) => names.has(name))
        const listed = reader ? formatSkillsForPrompt(skills, reader).trim() : ''
        return listed
          ? `${listed}\nWhen a task matches a listed skill, read it before you start; it carries the steps the project expects.`
          : undefined
      }),
      section('building_blocks', () => {
        const off = host.extensions().filter((extension) => !extension.enabled)
        if (!off.length) return undefined
        return [
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
        ].join('\n')
      }),
      section('environment', (input) => {
        const cwd = input.env?.cwd ?? input.agent.cwd ?? host.projectRoot
        return `Work checkout (effective cwd): ${cwd}\nHost project: ${host.projectRoot}\nRunning Ultimate host: ${host.ultimateRoot}\nUI: ${host.system().process.url} (shared host)\nDirect project edits to the effective cwd. Host-scoped config and extensions remain loaded from the host project and Ultimate clone; edits in a separate checkout do not hot-reload the running host.`
      }),
      section('cwd', (input) => input.env?.cwd ?? input.agent.cwd ?? host.projectRoot),
    ],
  })
}
