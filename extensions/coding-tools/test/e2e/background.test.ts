import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import type { createBashTool } from '@earendil-works/pi-durable/tools'
import codingTools from '../../server.ts'
import { sweepEarlierProcesses } from '../../background.ts'
import { context } from '../../../../server/harness.ts'
import { groupAlive, groupTarget, spawnGroup, stopGroup } from '../../../../lib/process-group.ts'
import { fauxServer, post, removeTemp, temp, until } from '../../../../test/helpers.ts'

let directory: string
let server: Awaited<ReturnType<typeof fauxServer>>
const started: number[] = []

beforeEach(async () => {
  directory = await temp('ultimate-background-')
  server = await fauxServer({
    ultimateRoot: resolve('.'),
    home: join(directory, 'home'),
    userHome: directory,
  })
})
afterEach(async () => {
  await server.close()
  await sweepEarlierProcesses(join(directory, 'home'), () => false)
  const groups = started.splice(0)
  await until(() => groups.every((pgid) => !groupAlive(pgid)))
  await removeTemp(directory)
})

async function background(conversation: ConversationId, command: string) {
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

const create = async () => (await post(server, '/api/conversations', {})).data.id as ConversationId
const conversationAction = (name: string, ids: number[]) =>
  post(server, `/api/extensions/conversations/actions/${name}`, { args: { ids } })
const groupsOf = async (id: number) =>
  readdir(join(server.host.home, 'background', String(id))).catch(() => [])

it('starts a command in its own group, logs its output and stops by the returned group', async () => {
  const id = await create()
  const { pgid, log } = await background(id, 'echo ready; echo oops >&2; exec sleep 300')
  expect(log.startsWith(join(server.host.home, 'background', String(id)))).toBe(true)
  await until(async () => (await readFile(log, 'utf8')) === 'ready\noops\n')
  expect(groupAlive(pgid)).toBe(true)
  process.kill(groupTarget(pgid), 'SIGTERM')
  await until(() => !groupAlive(pgid))
  await until(async () => !(await groupsOf(id)).some((file) => file.endsWith('.pid')))
})

it('concluding stops the groups started before it, and a resumed conversation keeps its new ones', async () => {
  const [concluded, other] = [await create(), await create()]
  const before = await background(concluded, 'exec sleep 300')
  const untouched = await background(other, 'exec sleep 300')
  expect((await conversationAction('conclude', [concluded])).status).toBe(200)
  await until(() => !groupAlive(before.pgid))
  await until(async () => (await groupsOf(concluded)).length === 0)
  expect((await conversationAction('resume', [concluded])).status).toBe(200)
  const after = await background(concluded, 'exec sleep 300')
  expect((await conversationAction('conclude', [other])).status).toBe(200)
  await until(() => !groupAlive(untouched.pgid))
  expect(groupAlive(after.pgid)).toBe(true)
})

it('stops the new group when the commit that records it fails', async () => {
  const home = join(directory, 'direct')
  const bash = codingTools({
    home,
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
  const id = await create()
  const own = await background(id, 'exec sleep 300')
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
