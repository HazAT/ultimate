import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { configure } from '@earendil-works/pi-durable'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Committed } from '../../../coding-tools/refs.ts'
import { context } from '../../../../server/harness.ts'
import { emit } from '../../../../server/events.ts'
import { fauxServer, post, sourceCopy, temp } from '../../../../test/helpers.ts'

let ultimateRoot: string
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp())
})
const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_COUNT: '0' } })
    .toString()
    .trim()

/** A repository and a conversation working in it; `EDIT <path>` makes the model call `edit` on that path. */
async function fixture(first: boolean) {
  const home = await temp('ultimate-rewind-git-')
  const repo = join(home, 'repo')
  await mkdir(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  const commit = async (file: string, text: string, subject: string) => {
    await writeFile(join(repo, file), text)
    git(repo, 'add', file)
    git(repo, 'commit', '-q', '-m', subject)
    return git(repo, 'rev-parse', 'HEAD')
  }
  if (first) await commit('base.ts', 'base\n', 'base')
  const server = await fauxServer({ ultimateRoot, home, userHome: home })
  servers.push(server)
  const route: FauxResponseFactory = (transcript) => {
    server.host.faux!.appendResponses([route])
    const last = transcript.messages.at(-1)!
    const text = typeof last.content === 'string' ? last.content : ''
    if (last.role === 'user' && text.startsWith('EDIT '))
      return fauxAssistantMessage(
        [fauxToolCall('write', { path: text.slice(5), content: 'written\n' })],
        { stopReason: 'toolUse' },
      )
    return fauxAssistantMessage(last.role === 'toolResult' ? 'done' : `echo ${text}`)
  }
  server.host.faux!.setResponses([route])
  const { model } = await server.root.agent(context)
  const conversation = await server.harness.createConversation(
    { ownership: { kind: 'ownerless' }, agent: { model } },
    context,
  )
  await server.harness.commit((tx) => configure(tx, conversation.id, { cwd: repo }), context)
  const ask = async (content: string) =>
    (await conversation.submit({ type: 'input', content }, context)).wait(context)
  const recorded = (sha: string, subject: string) =>
    server.harness.commit(
      (tx) =>
        emit(tx, Committed, {
          conversation: conversation.id,
          sha,
          parents: [git(repo, 'rev-parse', `${sha}^`)],
          repo,
          subject,
        }),
      context,
    )
  const call = (action: string, args: object) =>
    post(server, `/api/extensions/lineage/actions/${action}`, { args })
  const tail = async () => (await conversation.context(context)).entries.at(-1)!.id
  return { repo, conversation, ask, commit, recorded, call, tail }
}

it('lists what the set-aside path touched, counted against the entry, and leaves git as it is', async () => {
  const f = await fixture(true)
  // Before the entry: a commit, and uncommitted work in another file.
  await f.recorded(await f.commit('early.ts', 'early\n', 'early'), 'early')
  await writeFile(join(f.repo, 'before.md'), 'pending\n')
  await f.ask('one')
  const at = await f.tail()
  // After it: a commit, an edit of a tracked file through the write tool, and a new file the tool wrote.
  const late = await f.commit('late.ts', 'a\nb\n', 'late')
  await f.recorded(late, 'late')
  await f.ask(`EDIT ${join(f.repo, 'base.ts')}`)
  await f.ask('EDIT scratch.md')

  const preview = (await f.call('rewindPreview', { conversation: f.conversation.id, at })).data
    .result
  expect(preview.commits).toEqual([{ sha: late, subject: 'late' }])
  expect(preview.files).toEqual([
    { path: 'base.ts', added: 1, removed: 1 },
    { path: 'scratch.md', untracked: true },
    { path: 'late.ts', added: 2, removed: 0 },
  ])
  const status = git(f.repo, 'status', '--porcelain')
  const { data } = await f.call('rewind', { conversation: f.conversation.id, at })
  expect(data.error).toBeUndefined()
  const note = (await f.conversation.context(context)).messages.at(-1)!.content as string
  expect(note).toContain('- late.ts (+2 −0)')
  expect(note).toContain('- scratch.md (new, untracked)')
  // Neither the commit nor the uncommitted work from before the entry is the set-aside path's.
  expect(note).not.toContain('early.ts')
  expect(note).not.toContain('before.md')
  expect(note).toContain(`Commits since: ${late.slice(0, 7)} late`)
  expect(note).toContain("They're still there; decide whether to keep or undo them.")
  // Git is untouched: the same tip, the same files.
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(late)
  expect(git(f.repo, 'status', '--porcelain')).toBe(status)
  expect(await readFile(join(f.repo, 'base.ts'), 'utf8')).toBe('written\n')
})

it('lists the files the path wrote in a repository without a commit', async () => {
  const f = await fixture(false)
  await f.ask('one')
  const at = await f.tail()
  await f.ask('EDIT notes.md')
  const preview = (await f.call('rewindPreview', { conversation: f.conversation.id, at })).data
  expect(preview.error).toBeUndefined()
  expect(preview.result.files).toEqual([{ path: 'notes.md', untracked: true }])
  const { data } = await f.call('rewind', { conversation: f.conversation.id, at })
  expect(data.error).toBeUndefined()
  expect((await f.conversation.context(context)).messages.at(-1)!.content).toContain(
    '- notes.md (new, untracked)',
  )
})

it('lists an edit outside the checkout as changed, without asking git about it', async () => {
  const f = await fixture(true)
  await f.ask('one')
  const at = await f.tail()
  const outside = join(f.repo, '..', 'outside.txt')
  await f.ask(`EDIT ${outside}`)
  await f.ask('EDIT inside.md')
  const preview = (await f.call('rewindPreview', { conversation: f.conversation.id, at })).data
  expect(preview.error).toBeUndefined()
  expect(preview.result.files).toEqual([
    { path: 'inside.md', untracked: true },
    { path: resolve(outside), outside: true },
  ])
  const { data } = await f.call('rewind', { conversation: f.conversation.id, at })
  expect(data.error).toBeUndefined()
  expect((await f.conversation.context(context)).messages.at(-1)!.content).toContain(
    `- ${resolve(outside)} (changed, outside the checkout)`,
  )
})

it("lists a merge commit's changes against its first parent", async () => {
  const f = await fixture(true)
  await f.ask('one')
  const at = await f.tail()
  git(f.repo, 'checkout', '-q', '-b', 'side')
  await f.commit('side.ts', 'side\n', 'side')
  git(f.repo, 'checkout', '-q', 'main')
  git(f.repo, 'merge', '-q', '--no-ff', 'side', '-m', 'merge side')
  const merge = git(f.repo, 'rev-parse', 'HEAD')
  await f.recorded(merge, 'merge side')
  // A turn after the point, so there is something to set aside.
  await f.ask('merged')
  const preview = (await f.call('rewindPreview', { conversation: f.conversation.id, at })).data
    .result
  expect(preview.refused).toBeUndefined()
  expect(preview.commits).toEqual([{ sha: merge, subject: 'merge side' }])
  expect(preview.files).toEqual([{ path: 'side.ts', added: 1, removed: 0 }])
})

it('still lists a file written after a later point when going back again past it', async () => {
  const f = await fixture(true)
  await f.ask('one')
  const a = await f.tail()
  await f.ask('two')
  const b = await f.tail()
  await f.ask('EDIT later.md')
  expect((await f.call('rewind', { conversation: f.conversation.id, at: b })).data.error).toBe(
    undefined,
  )
  // The write is set aside now, but still on disk: going back further lists it again.
  const { data } = await f.call('rewind', { conversation: f.conversation.id, at: a })
  expect(data.error).toBeUndefined()
  expect((await f.conversation.context(context)).messages.at(-1)!.content).toContain(
    '- later.md (new, untracked)',
  )
})
