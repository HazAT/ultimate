import type { ConversationId, EntryId } from '@earendil-works/pi-durable'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { abstract, leaveNote } from '../../server.ts'
import { Roots } from '../../api.ts'
import { Seen } from '../../catchup.ts'
import { Standing } from '../../../subagents/api.ts'
import { context } from '../../../../server/harness.ts'
import {
  branchProbe,
  fauxServer,
  post,
  seedTally,
  sourceCopy,
  temp,
  until,
} from '../../../../test/helpers.ts'

let ultimateRoot: string
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp())
  await branchProbe(ultimateRoot)
  await writeFile(
    join(ultimateRoot, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['plan', 'subagents'] } }),
  )
})

type Server = Awaited<ReturnType<typeof fauxServer>>
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

const textOf = (content: unknown) =>
  typeof content === 'string'
    ? content
    : ((content ?? []) as { type: string; text?: string }[])
        .flatMap((part) => (part.type === 'text' ? [part.text!] : []))
        .join('')

const ask = async (server: Server, id: ConversationId, content: string) =>
  (
    await (await server.harness.conversation(id, context))!.submit(
      { type: 'input', content },
      context,
    )
  ).wait(context)

const repoGit = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_COUNT: '0' } })
    .toString()
    .trim()

async function scriptedProject() {
  const home = await temp('ultimate-lineage-main-')
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot)
  repoGit(projectRoot, 'init', '-b', 'main')
  repoGit(projectRoot, 'config', 'user.email', 'test@example.com')
  repoGit(projectRoot, 'config', 'user.name', 'Test')
  await writeFile(join(projectRoot, 'schema.ts'), 'base\n')
  repoGit(projectRoot, 'add', '.')
  repoGit(projectRoot, 'commit', '-m', 'base')
  return { config: { ultimateRoot, home, userHome: home, projectRoot }, projectRoot }
}

let scripts = 0
/** The faux model's answers for one test: it records the user messages of each request and can hold one open. */
function script(projectRoot: string) {
  const edit = `own edit ${scripts++}\n`
  const requests: string[][] = []
  const gate = Promise.withResolvers<void>()
  let held = false
  const attach = (server: Server) => {
    const route: FauxResponseFactory = async (transcript, options) => {
      server.host.faux!.appendResponses([route])
      requests.push(
        transcript.messages
          .filter((message) => message.role === 'user')
          .map((message) => textOf(message.content)),
      )
      const last = transcript.messages.at(-1)!
      const text = textOf(last.content)
      if (last.role === 'user' && text === 'edit schema')
        return fauxAssistantMessage(
          [fauxToolCall('write', { path: join(projectRoot, 'schema.ts'), content: edit })],
          { stopReason: 'toolUse' },
        )
      if (
        (last.role === 'toolResult' && text.includes('schema.ts')) ||
        (last.role === 'user' && text === 'resume during restart')
      ) {
        held = true
        await Promise.race([
          gate.promise,
          new Promise((_, fail) =>
            options?.signal?.addEventListener('abort', () => fail(new Error('closed'))),
          ),
        ])
      }
      return fauxAssistantMessage(`echo ${text}`)
    }
    server.host.faux!.setResponses([route])
  }
  return { requests, attach, release: () => gate.resolve(), held: () => held }
}

/** A test that reopens the server gets its own project and server. */
async function catchupFixture() {
  const { config, projectRoot } = await scriptedProject()
  const scripted = script(projectRoot)
  const open = async () => {
    const server = await fauxServer(config)
    servers.push(server)
    scripted.attach(server)
    return server
  }
  const server = await open()
  return { server, projectRoot, open, ...scripted }
}

let shared: { server: Server; projectRoot: string }
beforeAll(async () => {
  const { config, projectRoot } = await scriptedProject()
  shared = { server: await fauxServer(config), projectRoot }
}, 60_000)
afterAll(async () => {
  await shared?.server.close()
})

const freshConversation = async () =>
  (
    await shared.server.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: { model: { provider: 'faux', modelId: 'faux-1' } },
      },
      context,
    )
  ).id

/** The tests on the shared server each get their own conversation, so none sees another's notes or entries. */
async function sharedFixture() {
  const scripted = script(shared.projectRoot)
  scripted.attach(shared.server)
  const id = await freshConversation()
  await until(async () => !!(await shared.server.harness.snapshot(Seen, id, context))?.main)
  return { ...shared, ...scripted, id }
}

/** A conversation of its own that is the top of a tree, as the project's first one is. */
async function treeFixture() {
  const f = await sharedFixture()
  await f.server.harness.commit(async (tx) => {
    ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots.push(f.id)
  }, context)
  return f
}

const ctxOf = async (server: Server, id: ConversationId) =>
  (await server.harness.conversation(id, context))!.context(context)

it('catches up once on an idle resume, puts overlap first, and reads it before the input', async () => {
  const f = await catchupFixture()
  const seen = await f.server.harness.snapshot(Seen, ROOT_CONVERSATION_ID, context)
  expect(seen?.main).toBe(repoGit(f.projectRoot, 'rev-parse', 'main'))
  const editing = ask(f.server, ROOT_CONVERSATION_ID, 'edit schema')
  await until(f.held)
  f.release()
  await editing
  repoGit(f.projectRoot, 'add', '.')
  repoGit(f.projectRoot, 'commit', '-m', 'Fix schema\n\nUltimate-Conversation: 1')
  await writeFile(join(f.projectRoot, 'other.ts'), 'other\n')
  repoGit(f.projectRoot, 'add', '.')
  repoGit(f.projectRoot, 'commit', '-m', 'Add something unrelated')
  await ask(f.server, ROOT_CONVERSATION_ID, 'continue work')
  const notes = (await f.server.root.context(context)).entries.filter(
    (entry) =>
      entry.kind === 'lineage.note' && (entry.data as { source?: string }).source === 'main',
  )
  expect(notes).toHaveLength(1)
  const text = (notes[0].data as { text: string }).text
  expect(text).toContain('2 commits landed on main')
  expect(text).toMatch(/\*\*Overlap\*\* .*Fix schema · #1 edit schema/)
  expect(text).toContain('`schema.ts`')
  expect(text.indexOf('Fix schema')).toBeLessThan(text.indexOf('Add something unrelated'))
  expect(f.requests.at(-1)!.slice(-2)).toEqual([text, 'continue work'])
  const view = await f.server.root.context(context)
  const resumed = view.entries.find((entry) =>
    entry.model?.some(
      (message) => message.role === 'user' && textOf(message.content) === 'continue work',
    ),
  )!
  expect(notes[0].id).toBeLessThan(resumed.id)
  expect(notes[0].edits).toBeUndefined()
  expect(notes[0].model?.[0]?.content).toBe(text)
  expect(
    view.messages
      .filter((message) => message.role === 'user')
      .map((message) => textOf(message.content))
      .slice(-2),
  ).toEqual([text, 'continue work'])
  expect(view.entries.findLastIndex((entry) => entry.kind === 'pi.assistant')).toBeGreaterThan(
    view.entries.indexOf(notes[0]),
  )
  expect((await f.server.harness.snapshot(Seen, ROOT_CONVERSATION_ID, context))?.main).toBe(
    repoGit(f.projectRoot, 'rev-parse', 'main'),
  )
  await ask(f.server, ROOT_CONVERSATION_ID, 'continue again')
  expect(
    (await f.server.root.context(context)).entries.filter((entry) => entry.kind === 'lineage.note'),
  ).toHaveLength(1)

  await f.server.close()
  servers.splice(servers.indexOf(f.server), 1)
  const reopened = await f.open()
  await ask(reopened, ROOT_CONVERSATION_ID, 'after restart')
  expect(
    (await reopened.root.context(context)).entries.filter((entry) => entry.kind === 'lineage.note'),
  ).toHaveLength(1)
  expect(f.requests.at(-1)!.filter((message) => message === text)).toHaveLength(1)
})

it('does not catch up when a note and new commits arrive in the middle of a run', async () => {
  const f = await sharedFixture()
  const run = ask(f.server, f.id, 'edit schema')
  await until(f.held)
  repoGit(f.projectRoot, 'add', '.')
  repoGit(f.projectRoot, 'commit', '-m', 'Landed during work')
  await leaveNote({ harness: () => f.server.harness }, f.id, 'A sibling left a note.', {
    from: 2 as ConversationId,
  })
  f.release()
  await run
  let view = await ctxOf(f.server, f.id)
  expect(
    view.entries
      .filter((entry) => entry.kind === 'lineage.note')
      .map((entry) => (entry.data as { source?: string }).source),
  ).toEqual([undefined])
  await ask(f.server, f.id, 'resume after idle')
  view = await ctxOf(f.server, f.id)
  expect(
    view.entries.filter(
      (entry) =>
        entry.kind === 'lineage.note' && (entry.data as { source?: string }).source === 'main',
    ),
  ).toHaveLength(1)
})

// Own server: it names @ultimate in the project-wide Standing document.
it('gives @ultimate no commit catch-up: its landing cards already name each landing', async () => {
  const f = await catchupFixture()
  await f.server.harness.commit(async (tx) => {
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = ROOT_CONVERSATION_ID
  }, context)
  repoGit(f.projectRoot, 'commit', '--allow-empty', '-m', 'Landed meanwhile')
  await ask(f.server, ROOT_CONVERSATION_ID, 'continue work')
  expect(
    (await f.server.root.context(context)).entries.filter((entry) => entry.kind === 'lineage.note'),
  ).toEqual([])
})

it('does not put commit catch-up notes in an ownerless fork of @ultimate', async () => {
  const f = await catchupFixture()
  const main = await f.server.harness.createConversation(
    {
      ownership: { kind: 'ownerless' },
      agent: { model: (await f.server.root.agent(context)).model },
    },
    context,
  )
  await f.server.harness.commit(async (tx) => {
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = main.id
  }, context)
  await ask(f.server, main.id, 'first work')
  const at = (await main.context(context)).entries.at(-1)!.id
  const fork = await main.fork(at, { ownership: { kind: 'ownerless' } }, context)
  await ask(f.server, fork.id, 'first voice input')
  repoGit(f.projectRoot, 'commit', '--allow-empty', '-m', 'Landed meanwhile')
  await ask(f.server, fork.id, 'second voice input')
  expect(
    (await fork.context(context)).entries.filter((entry) => entry.kind === 'lineage.note'),
  ).toEqual([])
})

it('keeps a catch-up exactly once when reopened during the first request', async () => {
  const f = await catchupFixture()
  await ask(f.server, ROOT_CONVERSATION_ID, 'first work')
  await writeFile(join(f.projectRoot, 'schema.ts'), 'landed\n')
  repoGit(f.projectRoot, 'add', '.')
  repoGit(f.projectRoot, 'commit', '-m', 'Land schema')
  const interrupted = ask(f.server, ROOT_CONVERSATION_ID, 'resume during restart').catch(
    () => undefined,
  )
  await until(f.held)
  expect(
    (await f.server.root.context(context)).entries.filter((entry) => entry.kind === 'lineage.note'),
  ).toHaveLength(1)
  await f.server.close()
  servers.splice(servers.indexOf(f.server), 1)
  await interrupted
  const reopened = await f.open()
  f.release()
  await reopened.root.waitForIdle(context)
  const view = await reopened.root.context(context)
  const notes = view.entries.filter((entry) => entry.kind === 'lineage.note')
  expect(notes).toHaveLength(1)
  expect(f.requests.at(-1)!.slice(-2)).toEqual([
    (notes[0].data as { text: string }).text,
    'resume during restart',
  ])
})

it('counts a merged upstream as the one merge that landed it, not its every commit and path', async () => {
  const f = await sharedFixture()
  const editing = ask(f.server, f.id, 'edit schema')
  await until(f.held)
  f.release()
  await editing
  repoGit(f.projectRoot, 'commit', '-am', 'Own schema edit')
  await ask(f.server, f.id, 'baseline')
  // A long upstream merged in: its own commits are not what landed on main, the merge is.
  repoGit(f.projectRoot, 'checkout', '-q', '-b', 'upstream', 'HEAD~1')
  for (let i = 0; i < 40; i++) {
    await writeFile(join(f.projectRoot, `up${i}.ts`), `${i}\n`)
    repoGit(f.projectRoot, 'add', '.')
    repoGit(f.projectRoot, 'commit', '-qm', `Upstream ${i}`)
  }
  repoGit(f.projectRoot, 'checkout', '-q', 'main')
  repoGit(f.projectRoot, 'merge', '-q', '--no-ff', '-m', 'Merge upstream', 'upstream')
  await ask(f.server, f.id, 'after merge')
  const notes = (await ctxOf(f.server, f.id)).entries.filter(
    (entry) =>
      entry.kind === 'lineage.note' && (entry.data as { source?: string }).source === 'main',
  )
  const text = (notes.at(-1)!.data as { text: string }).text
  expect(text).toContain('1 commits landed on main')
  expect(text).toMatch(/Merge upstream/)
  expect(text).not.toContain('Upstream 1')
  expect(text).not.toContain('up1.ts')
})

it('prioritizes old overlaps and caps the rows at 30', async () => {
  const f = await sharedFixture()
  const editing = ask(f.server, f.id, 'edit schema')
  await until(f.held)
  f.release()
  await editing
  repoGit(f.projectRoot, 'commit', '-am', 'Old overlap')
  for (let i = 0; i < 31; i++) repoGit(f.projectRoot, 'commit', '--allow-empty', '-m', `Other ${i}`)
  await ask(f.server, f.id, 'continue work')
  const [note] = (await ctxOf(f.server, f.id)).entries.filter(
    (entry) => entry.kind === 'lineage.note',
  )
  const text = (note.data as { text: string }).text
  expect(text).toContain('32 commits landed on main')
  expect(text.split('\n\n')[1]).toMatch(/^- \*\*Overlap\*\* .*Old overlap.*schema.ts/)
  expect(text.split('\n\n').filter((row) => row.startsWith('- '))).toHaveLength(30)
  expect(text).toContain('and 2 more')
})

it('tells a resumed branch only the commits that overlap its checkout, and that it is behind', async () => {
  const f = await treeFixture()
  await ask(f.server, f.id, 'An idea')
  const { id } = (
    await post(f.server, '/api/extensions/branch-probe/actions/branch', {
      args: { from: f.id, prompt: 'Branch task', isolated: true },
    })
  ).data.result as { id: ConversationId }
  const branch = (await f.server.harness.conversation(id, context))!
  await branch.waitForIdle(context)
  const workspace = (await branch.agent(context)).cwd!
  await writeFile(join(workspace, 'schema.ts'), 'own workspace change\n')
  await writeFile(join(workspace, 'new.ts'), 'own untracked file\n')
  await writeFile(join(f.projectRoot, 'schema.ts'), 'overlapping landing\n')
  repoGit(f.projectRoot, 'add', '.')
  repoGit(f.projectRoot, 'commit', '-m', 'Old overlap')
  await writeFile(join(f.projectRoot, 'new.ts'), 'same new path\n')
  repoGit(f.projectRoot, 'add', '.')
  repoGit(f.projectRoot, 'commit', '-m', 'Add new')
  for (let i = 0; i < 3; i++) repoGit(f.projectRoot, 'commit', '--allow-empty', '-m', `Other ${i}`)
  await ask(f.server, id, 'Continue branch')
  const notes = () =>
    branch
      .context(context)
      .then(({ entries }) =>
        entries.filter((entry) => entry.conversationId === id && entry.kind === 'lineage.note'),
      )
  const [note] = await notes()
  const sha = (rev: string) => repoGit(f.projectRoot, 'rev-parse', '--short=7', rev)
  expect((note.data as { text: string }).text).toBe(
    [
      '2 new commits on main overlap your checkout:',
      `- \`${sha('main~3')}\` Add new — \`new.ts\``,
      `- \`${sha('main~4')}\` Old overlap — \`schema.ts\``,
      'Your workspace is 5 commits behind main; merge it before continuing.',
      'Check whether any of this already covers or changes what you are about to do.',
    ].join('\n\n'),
  )
  // Commits that touch nothing the branch changed bring no note.
  repoGit(f.projectRoot, 'commit', '--allow-empty', '-m', 'Unrelated')
  await ask(f.server, id, 'Continue again')
  expect(await notes()).toHaveLength(1)
})

const branchFrom = async (server: Server, args: Record<string, unknown>) => {
  // An empty first conversation is a root that read nothing yet; one with history stays an ordinary root.
  await seedTally(server.harness, args.from as number)
  const { status, data } = await post(server, '/api/extensions/branch-probe/actions/branch', {
    args,
  })
  expect([status, data.error]).toEqual([200, undefined])
  const id = data.result.id as ConversationId
  await (await server.harness.conversation(id, context))!.waitForIdle(context)
  return id
}
const writeAbstract = (server: Server, id: ConversationId, text: string, title?: string) =>
  server.harness.commit(
    (tx) =>
      abstract(tx, id, { text, at: 1 as EntryId, ...(title ? { title, feature: 'Tally' } : {}) }),
    context,
  )
const land = (server: Server, from: ConversationId, sha: string, divergence: string) =>
  leaveNote({ harness: () => server.harness }, 'root', `Landed ${sha.slice(0, 7)}`, {
    from,
    source: 'lander',
    data: { at: 7, divergence, sha, target: 'main', title: `Landing of #${from}` },
  })
const catchups = async (server: Server, id: ConversationId) =>
  (await (await server.harness.conversation(id, context))!.context(context)).entries.filter(
    (entry) =>
      entry.conversationId === id &&
      entry.kind === 'lineage.note' &&
      (entry.data as { source?: string }).source === 'main',
  )

it('keeps its tree’s sibling abstracts, prompts, landings and notes out of a resumed branch', async () => {
  const f = await treeFixture()
  const own = await branchFrom(f.server, { from: f.id, prompt: 'Resume me' })
  const sibling = await branchFrom(f.server, { from: f.id, prompt: 'Sibling feature' })
  await writeAbstract(f.server, sibling, 'Ask: sibling\nState: in progress', 'Sibling')
  await land(f.server, sibling, 'abcdef1234567', 'Used SQLite instead of JSON files')
  await leaveNote({ harness: () => f.server.harness }, 'root', 'For future branches.', {
    from: sibling,
  })
  repoGit(f.projectRoot, 'commit', '--allow-empty', '-m', 'Landed meanwhile')
  await ask(f.server, own, 'continue')
  expect(await catchups(f.server, own)).toEqual([])
  expect(f.requests.at(-1)!.at(-1)).toBe('continue')
  expect(JSON.stringify(f.requests.at(-1))).not.toMatch(/Sibling|abcdef1|future branches/)
})
