import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import type { createBashTool } from '@earendil-works/pi-durable/tools'
import codingTools from '../../server.ts'
import { sweepEarlierProcesses } from '../../background.ts'
import { BackgroundEndedEntry } from '../../refs.ts'
import { context } from '../../../../server/harness.ts'
import { groupAlive, groupTarget, spawnGroup, stopGroup } from '../../../../lib/process-group.ts'
import { fauxServer, post, removeTemp, temp, until } from '../../../../test/helpers.ts'

type Server = Awaited<ReturnType<typeof fauxServer>>
let directory: string
const servers: Server[] = []
const started: number[] = []

beforeEach(async () => {
  directory = await temp('ultimate-background-')
})
afterEach(async () => {
  const [closing, home, groups] = [servers.splice(0), directory, started.splice(0)]
  for (const server of closing) await server.close()
  await sweepEarlierProcesses(join(home, 'home'), () => false)
  await until(() => groups.every((pgid) => !groupAlive(pgid)))
  await removeTemp(home)
})

/** Boot this test's server in its body: a boot slowed by other files' boots counts against the test, not a hook. */
async function boot() {
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    home: join(directory, 'home'),
    userHome: directory,
  })
  servers.push(server)
  return server
}

async function background(server: Server, conversation: ConversationId, command: string) {
  server.host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('bash', { command, background: true })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('Started'),
  ])
  const handle = (await server.harness.conversation(conversation, context))!
  await (await handle.submit({ type: 'input', content: 'Start it' }, context)).wait(context)
  const view = await handle.context(context)
  const text = JSON.stringify(
    view.entries.filter((entry: { kind: string }) => entry.kind === 'pi.tool-result').at(-1)?.model,
  )
  const pgid = Number(/process group (\d+)/.exec(text)![1])
  started.push(pgid)
  return { pgid, log: /Output: ([^\\]+)/.exec(text)![1] }
}

const create = async (server: Server) =>
  (await post(server, '/api/conversations', {})).data.id as ConversationId
const conversationAction = (server: Server, name: string, ids: number[]) =>
  post(server, `/api/extensions/conversations/actions/${name}`, { args: { ids } })
const groupsOf = async (server: Server, id: number) =>
  readdir(join(server.host.home, 'background', String(id))).catch(() => [])

it('starts a command in its own group, logs its output and stops by the returned group', async () => {
  const server = await boot()
  const id = await create(server)
  const { pgid, log } = await background(server, id, 'echo ready; echo oops >&2; exec sleep 300')
  expect(log.startsWith(join(server.host.home, 'background', String(id)))).toBe(true)
  await until(async () => (await readFile(log, 'utf8')) === 'ready\noops\n')
  expect(groupAlive(pgid)).toBe(true)
  process.kill(groupTarget(pgid), 'SIGTERM')
  await until(() => !groupAlive(pgid))
  await until(async () => !(await groupsOf(server, id)).some((file) => file.endsWith('.pid')))
})

it('wakes the idle conversation once, with its exit code and log tail, when a background command ends', async () => {
  const server = await boot()
  const id = await create(server)
  const go = join(directory, 'go')
  await background(
    server,
    id,
    `until [ -e '${go}' ]; do sleep 0.05; done; seq 1 30; echo failing >&2; exit 3`,
  )
  server.host.faux!.setResponses([fauxAssistantMessage('Saw it fail')])
  await writeFile(go, '')
  const handle = (await server.harness.conversation(id, context))!
  const ended = async () =>
    (await handle.context(context)).entries.filter(
      (entry: { kind: string }) => entry.kind === 'coding-tools.background-ended',
    )
  await until(async () => (await ended()).length === 1)
  const [entry] = await ended()
  if (!BackgroundEndedEntry.is(entry)) throw new Error('Not a background-ended entry')
  expect(entry.data).toMatchObject({ exitCode: 3, signal: null })
  expect(entry.data.tail.split('\n')).toEqual([
    ...Array.from({ length: 19 }, (_, i) => String(i + 12)),
    'failing',
  ])
  expect(JSON.stringify(entry.model)).toContain('exited with code 3')
  await until(async () =>
    JSON.stringify((await handle.context(context)).entries.at(-1)?.model).includes('Saw it fail'),
  )
  await until(async () => !(await groupsOf(server, id)).some((file) => file.endsWith('.pid')))
  expect(await ended()).toHaveLength(1)
})

it('concluding stops the groups started before it, and a resumed conversation keeps its new ones', async () => {
  const server = await boot()
  const [concluded, other] = [await create(server), await create(server)]
  const before = await background(server, concluded, 'exec sleep 300')
  const untouched = await background(server, other, 'exec sleep 300')
  expect((await conversationAction(server, 'conclude', [concluded])).status).toBe(200)
  await until(() => !groupAlive(before.pgid))
  await until(async () => (await groupsOf(server, concluded)).length === 0)
  expect((await conversationAction(server, 'resume', [concluded])).status).toBe(200)
  const after = await background(server, concluded, 'exec sleep 300')
  expect((await conversationAction(server, 'conclude', [other])).status).toBe(200)
  await until(() => !groupAlive(untouched.pgid))
  expect(groupAlive(after.pgid)).toBe(true)
})

it('stops the new group when the commit that records it fails', async () => {
  const home = join(directory, 'direct')
  const bash = codingTools({
    home,
    harness: undefined as never,
    images: undefined as never,
    need: (() => ({ concludedIn: async () => new Set() })) as never,
    notice: () => {},
    emit: (async () => undefined) as never,
    onOpen: () => {},
    react: () => {},
  }).tools!.find((tool) => tool.name === 'bash') as ReturnType<typeof createBashTool>
  const spawned: number[] = []
  const api = {
    conversationId: 7,
    env: new NodeExecutionEnv({ cwd: directory }),
    commit: async () => {
      const groups = join(home, 'background', '7')
      const pidFile = (await readdir(groups)).find((file) => file.endsWith('.pid'))!
      spawned.push(Number(await readFile(join(groups, pidFile), 'utf8')))
      started.push(...spawned)
      expect(groupAlive(spawned[0])).toBe(true)
      throw new Error('aborted by the conclusion')
    },
  } as unknown as ToolExecutionApi
  await expect(
    bash.execute({ command: 'exec sleep 300', background: true } as never, api, context),
  ).rejects.toThrow('aborted by the conclusion')
  expect(spawned).toHaveLength(1)
  expect(groupAlive(spawned[0])).toBe(false)
  expect(
    (await readdir(join(home, 'background', '7'))).every((file) => !file.endsWith('.pid')),
  ).toBe(true)
})

it('stops on open what an earlier process recorded and keeps its own', async () => {
  const server = await boot()
  const id = await create(server)
  const own = await background(server, id, 'exec sleep 300')
  const earlier = join(server.host.home, 'background', '999')
  await mkdir(earlier, { recursive: true })
  const leftover = spawnGroup('sleep', ['300'], { pidFile: join(earlier, '1234567-x.pid') })
  const leftoverPid = leftover.child.pid!
  try {
    await sweepEarlierProcesses(server.host.home)
    expect(groupAlive(leftoverPid)).toBe(false)
    expect(groupAlive(own.pgid)).toBe(true)
  } finally {
    await stopGroup(leftoverPid, { leader: leftover })
  }
})
