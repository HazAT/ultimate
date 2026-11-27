import type { ConversationId } from '@earendil-works/pi-durable'
import { defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { Tx } from '@earendil-works/pi-durable'
import { randomUUID } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'
import { mkdir, open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isMissing, inProcess } from '../../lib/errors.shared.ts'
import { readPidFile, spawnGroup, stopGroup, sweepPidFiles } from '../../lib/process-group.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { checkpointEvery } from '../../shared/checkpoint.ts'

export type Started = { conversation: ConversationId; name: string }

export const BackgroundGroups = defineDoc<{ started: Record<string, string[]> }>({
  kind: 'coding-tools.background',
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ started: {} }),
})

const groups = (home: string) => join(home, 'background')
const conversationGroups = (home: string, id: string) => join(groups(home), id)
const startedByThisProcess = (name: string) => name.startsWith(`${process.pid}-`)
const quoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`
export const dropHostNodeEnv = 'unset NODE_ENV'

export async function startBackground(
  host: Pick<ExtensionHost, 'home' | 'notice'>,
  conversation: ConversationId,
  cwd: string,
  command: string,
  signal?: AbortSignal,
) {
  const directory = conversationGroups(host.home, String(conversation))
  await mkdir(directory, { recursive: true })
  signal?.throwIfAborted()
  const name = `${process.pid}-${randomUUID()}`
  const pidFile = join(directory, `${name}.pid`)
  const log = join(directory, `${name}.log`)
  writeFileSync(log, '')
  const group = spawnGroup(
    'bash',
    ['-c', `exec </dev/null >>${quoted(log)} 2>&1\n${dropHostNodeEnv}\n${command}`],
    { cwd, pidFile },
  )
  const { pid } = group.child
  if (pid === undefined) throw new Error('The background command did not start')
  group.child.stdout.resume()
  let logFailed = false
  group.child.stderr.on('data', (data: Buffer) => {
    if (logFailed) return
    try {
      appendFileSync(log, data)
    } catch (error) {
      logFailed = true
      host.notice(`Background group ${pid}: ${String(error)}`)
    }
  })
  inProcess(
    'this process owns the group until it exits; a restart sweeps what it recorded',
    group.ended
      .then(() => stopGroup(pid, { pidFile, leader: group }))
      .catch((error: unknown) => host.notice(`Background group ${pid}: ${String(error)}`)),
  )
  return {
    pgid: pid,
    log,
    started: { conversation, name },
    stop: () => stopGroup(pid, { pidFile, leader: group }),
    exited: group.ended.then(() => ({
      exitCode: group.child.exitCode,
      signal: group.child.signalCode,
    })),
  }
}

export async function logTail(path: string, lines = 20, chars = 4000) {
  let file
  try {
    file = await open(path)
  } catch (error) {
    if (isMissing(error)) return ''
    throw error
  }
  try {
    const { size } = await file.stat()
    const start = Math.max(0, size - chars * 4)
    const { buffer, bytesRead } = await file.read(
      Buffer.alloc(size - start),
      0,
      size - start,
      start,
    )
    const kept = buffer.subarray(0, bytesRead).toString('utf8').trimEnd().split('\n')
    if (start > 0 && kept.length > 1) kept.shift()
    return kept.slice(-lines).join('\n').slice(-chars)
  } finally {
    await file.close()
  }
}

export async function recordStarted(tx: Tx, { conversation, name }: Started) {
  const { started } = await tx.doc(BackgroundGroups, ROOT_CONVERSATION_ID)
  started[conversation] = [...(started[conversation] ?? []), name]
}

export async function takeStarted(tx: Tx, conversations: ConversationId[]) {
  const { started } = await tx.doc(BackgroundGroups, ROOT_CONVERSATION_ID)
  const taken: Started[] = []
  for (const conversation of conversations) {
    for (const name of started[conversation] ?? []) taken.push({ conversation, name })
    delete started[conversation]
  }
  return taken
}

export async function stopStarted(home: string, taken: Started[]) {
  for (const { conversation, name } of taken) {
    const pidFile = join(conversationGroups(home, String(conversation)), `${name}.pid`)
    const pid = await readPidFile(pidFile)
    if (pid) await stopGroup(pid, { pidFile })
    await rm(join(conversationGroups(home, String(conversation)), `${name}.log`), { force: true })
  }
}

async function filesIn(directory: string) {
  try {
    return await readdir(directory)
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

export async function sweepEarlierProcesses(home: string, keep = startedByThisProcess) {
  for (const id of await filesIn(groups(home))) {
    const directory = conversationGroups(home, id)
    await sweepPidFiles(directory, keep)
    for (const file of await filesIn(directory))
      if (!keep(file)) await rm(join(directory, file), { force: true })
  }
}
