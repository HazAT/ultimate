import { mkdir, readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ConversationId, ToolExecutionApi } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import type { createBashTool } from '@earendil-works/pi-durable/tools'
import codingTools from '../../server.ts'
import { stopConcluded, sweepEarlierProcesses } from '../../background.ts'
import { context } from '../../../../server/harness.ts'
import { groupAlive, groupTarget, spawnGroup, stopGroup } from '../../../../lib/process-group.ts'
import type { ExtensionHost } from '../../../../server/extensions.ts'
import { removeTemp, temp, until } from '../../../../test/helpers.ts'

let home: string
const ids = [7, 8, 9] as ConversationId[]

beforeEach(async () => {
  home = await temp('ultimate-background-')
})
afterEach(async () => {
  await stopConcluded(home, ids, Infinity)
  await removeTemp(home)
})

function tools() {
  const extension = codingTools({
    home,
    notice: () => {},
    emit: (async () => undefined) as unknown as ExtensionHost['emit'],
    onOpen: () => {},
    react: () => {},
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

const files = async (id: number) => readdir(join(home, 'background', String(id)))

it('starts a command in its own group, logs its output and stops by the returned group', async () => {
  const background = tools()
  const started = await background('echo ready; echo oops >&2; exec sleep 300')
  expect(started.text).toContain(`kill -- -${started.pgid}`)
  expect(started.log.startsWith(join(home, 'background', '7'))).toBe(true)
  await until(async () => (await readFile(started.log, 'utf8')) === 'ready\noops\n')
  expect(groupAlive(started.pgid)).toBe(true)
  process.kill(groupTarget(started.pgid), 'SIGTERM')
  await until(() => !groupAlive(started.pgid))
  await until(async () => !(await files(7)).some((file) => file.endsWith('.pid')))
})

it('stops the groups of concluded conversations started before the conclusion, and no others', async () => {
  const background = tools()
  const [mine, child, other] = [
    await background('exec sleep 300', 7),
    await background('exec sleep 300', 8),
    await background('exec sleep 300', 9),
  ]
  const concludedAt = Date.now()
  await until(() => Date.now() > concludedAt)
  const resumed = await background('exec sleep 300', 7)
  await stopConcluded(home, [7, 8] as ConversationId[], concludedAt)
  expect([mine, child].map(({ pgid }) => groupAlive(pgid))).toEqual([false, false])
  expect([other, resumed].map(({ pgid }) => groupAlive(pgid))).toEqual([true, true])
  const resumedName = basename(resumed.log, '.log')
  expect((await files(7)).toSorted()).toEqual([
    `${resumedName}.log`,
    `${resumedName}.pid`,
    `${resumedName}.pid.start`,
  ])
  expect(await files(8)).toEqual([])
})

it('stops on open what an earlier process recorded and keeps its own', async () => {
  const background = tools()
  const own = await background('exec sleep 300', 7)
  const directory = join(home, 'background', '8')
  await mkdir(directory)
  const pidFile = join(directory, '1234567-1-earlier.pid')
  const leftover = spawnGroup('sleep', ['300'], { pidFile })
  const leftoverPid = leftover.child.pid!
  try {
    expect(groupAlive(leftoverPid)).toBe(true)
    await sweepEarlierProcesses(home)
    expect(groupAlive(leftoverPid)).toBe(false)
    expect(groupAlive(own.pgid)).toBe(true)
  } finally {
    await stopGroup(leftoverPid, { leader: leftover })
  }
})
