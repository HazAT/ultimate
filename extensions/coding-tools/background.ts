import type { ConversationId } from '@earendil-works/pi-durable'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isMissing, inProcess } from '../../lib/errors.ts'
import { spawnGroup, stopGroup, sweepPidFiles } from '../../lib/process-group.ts'
import type { ExtensionHost } from '../../server/extensions.ts'

type Host = Pick<ExtensionHost, 'home' | 'notice'>

const groups = (home: string) => join(home, 'background')
const conversationGroups = (home: string, id: string) => join(groups(home), id)
const startedByThisProcess = (name: string) => name.startsWith(`${process.pid}-`)
const startedAfter = (at: number) => (name: string) => Number(name.split('-')[1]) > at
const quoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

export async function startBackground(
  host: Host,
  conversation: ConversationId,
  cwd: string,
  command: string,
  signal?: AbortSignal,
) {
  const directory = conversationGroups(host.home, String(conversation))
  await mkdir(directory, { recursive: true })
  signal?.throwIfAborted()
  const name = `${process.pid}-${Date.now()}-${randomUUID()}`
  const pidFile = join(directory, `${name}.pid`)
  const log = join(directory, `${name}.log`)
  writeFileSync(log, '')
  const group = spawnGroup('bash', ['-c', `exec </dev/null >>${quoted(log)} 2>&1\n${command}`], {
    cwd,
    pidFile,
  })
  const { pid } = group.child
  if (pid === undefined) throw new Error('The background command did not start')
  group.child.stdout.resume()
  group.child.stderr.resume()
  inProcess(
    'this process owns the group until it exits; a restart sweeps what it recorded',
    group.ended
      .then(() => stopGroup(pid, { pidFile, leader: group }))
      .catch((error: unknown) => host.notice(`Background group ${pid}: ${String(error)}`)),
  )
  return { pgid: pid, log, stop: () => stopGroup(pid, { pidFile, leader: group }) }
}

async function filesIn(directory: string) {
  try {
    return await readdir(directory)
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

async function sweep(home: string, ids: string[], keep: (name: string) => boolean) {
  for (const id of ids) {
    const directory = conversationGroups(home, id)
    await sweepPidFiles(directory, keep)
    for (const file of await filesIn(directory))
      if (!keep(file)) await rm(join(directory, file), { force: true })
  }
}

export const stopConcluded = (home: string, ids: ConversationId[], concludedAt: number) =>
  sweep(home, ids.map(String), startedAfter(concludedAt))

export const sweepEarlierProcesses = async (home: string) =>
  sweep(home, await filesIn(groups(home)), startedByThisProcess)
