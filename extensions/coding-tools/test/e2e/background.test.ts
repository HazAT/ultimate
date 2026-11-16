import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ConversationId, ToolExecutionApi } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import type { createBashTool } from '@earendil-works/pi-durable/tools'
import codingTools from '../../server.ts'
import { context } from '../../../../server/harness.ts'
import { groupAlive, groupTarget, spawnGroup } from '../../../../lib/process-group.ts'
import type { ExtensionHost } from '../../../../server/extensions.ts'
import { removeTemp, temp, until } from '../../../../test/helpers.ts'

let home: string
let opened: () => Promise<void>
let concluded: (ids: ConversationId[]) => unknown
const notices: string[] = []

beforeEach(async () => {
  home = await temp('ultimate-background-')
  notices.length = 0
})
afterEach(async () => {
  await opened?.()
  await concluded?.([7, 8] as ConversationId[])
  await removeTemp(home)
})

function tools() {
  const extension = codingTools({
    home,
    notice: (message) => notices.push(message),
    emit: (async () => undefined) as unknown as ExtensionHost['emit'],
    onOpen: (callback) => (opened = callback),
    react: ((_name: string, _events: unknown, handler: (tx: never, event: unknown) => unknown) =>
      (concluded = (ids) =>
        handler(undefined as never, { data: { conversations: ids } }))) as ExtensionHost['react'],
  })
  const bash = extension.tools!.find((tool) => tool.name === 'bash') as ReturnType<
    typeof createBashTool
  >
  return async (command: string, conversation = 7) => {
    const api = {
      conversationId: conversation as ConversationId,
      env: new NodeExecutionEnv({ cwd: home }),
    } as unknown as ToolExecutionApi
    const result = await bash.execute({ command, background: true } as never, api, context)
    const text = (result.output as { text: string }[])[0].text
    return {
      text,
      pgid: Number(/process group (\d+)/.exec(text)![1]),
      log: /Output: (.+)/.exec(text)![1],
    }
  }
}

it('starts a command in its own group, logs its output and stops by the returned group', async () => {
  const background = tools()
  const started = await background('echo ready; echo oops >&2; exec sleep 300')
  expect(started.text).toContain(`kill -- -${started.pgid}`)
  expect(started.log.startsWith(join(home, 'background', '7'))).toBe(true)
  await until(async () => (await readFile(started.log, 'utf8')) === 'ready\noops\n')
  expect(groupAlive(started.pgid)).toBe(true)
  process.kill(groupTarget(started.pgid), 'SIGTERM')
  await until(() => !groupAlive(started.pgid))
  await until(
    async () => !(await readdir(join(home, 'background', '7'))).some((f) => f.endsWith('.pid')),
  )
})

it('stops the groups of concluded conversations and leaves the others running', async () => {
  const background = tools()
  const [mine, child, other] = [
    await background('exec sleep 300', 7),
    await background('exec sleep 300', 8),
    await background('exec sleep 300', 9),
  ]
  await concluded([7, 8] as ConversationId[])
  await until(() => !groupAlive(mine.pgid) && !groupAlive(child.pgid))
  await until(async () => (await readdir(join(home, 'background'))).join() === '9')
  expect(groupAlive(other.pgid)).toBe(true)
  await concluded([9] as ConversationId[])
  await until(() => !groupAlive(other.pgid))
  expect(notices).toEqual([])
})

it('stops on open what an earlier process recorded and keeps its own', async () => {
  const background = tools()
  const own = await background('exec sleep 300', 7)
  const directory = join(home, 'background', '8')
  await mkdir(directory)
  const leftover = spawnGroup('sleep', ['300'], { pidFile: join(directory, '1234567-earlier.pid') })
  const leftoverPid = leftover.child.pid!
  expect(groupAlive(leftoverPid)).toBe(true)
  await opened()
  expect(groupAlive(leftoverPid)).toBe(false)
  expect(groupAlive(own.pgid)).toBe(true)
  expect(notices).toEqual([])
})
