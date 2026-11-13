import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import {
  temp,
  removeTemp,
  sourceCopy,
  cleanEnv,
  until,
  attach as attachStream,
} from '../helpers.ts'
import { join } from 'node:path'
import type { ConversationView } from '@earendil-works/pi-durable'
import { afterAll, afterEach } from 'vitest'
import { scriptedModel } from './scripted-model.ts'
import type { Answer, Turn } from './scripted-model.ts'

/**
 * The model every launched Ultimate runs on: `restart yourself` calls `restart`; `demo` writes `scratch.txt` in the
 * project with a slow `bash`, edits it, then answers `## Complete`; a tool result is echoed; anything else is done.
 */
function answer(last: Turn): Answer {
  if (last.role === 'user' && last.text === 'restart yourself')
    return { tool: { name: 'restart', args: {} } }
  if (last.role === 'user' && last.text === 'demo')
    return {
      text: 'I will demonstrate a slow shell command and a file edit.',
      tool: {
        name: 'bash',
        args: {
          command: "printf 'before\\n' > scratch.txt; echo starting; sleep 2; echo finished",
        },
      },
    }
  if (last.role === 'tool' && last.text.includes('finished'))
    return {
      tool: {
        name: 'edit',
        args: { path: 'scratch.txt', edits: [{ oldText: 'before', newText: 'after' }] },
      },
    }
  if (last.role === 'tool' && last.text.startsWith('Successfully')) return { text: '## Complete' }
  if (last.role === 'tool') return { text: last.text }
  return { text: 'Done.' }
}
let model: Awaited<ReturnType<typeof scriptedModel>> | undefined
afterAll(async () => {
  await model?.close()
  model = undefined
})

export const children: ChildProcess[] = []
export const homes: string[] = []
const streams: { close(): Promise<void> }[] = []
afterEach(async () => {
  // Every list before the first await, so a hook past its timeout cannot stop or delete the next test's.
  const closing = streams.splice(0)
  const stopping = children.splice(0)
  const taken = homes.splice(0)
  for (const stream of closing) await stream.close()
  for (const child of stopping) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
  }
  for (const home of taken) await removeTemp(home)
})
export const copies = new Map<string, string>()
export async function launch(home: string) {
  const ultimateRoot = copies.get(home) ?? (await sourceCopy(home))
  copies.set(home, ultimateRoot)
  model ??= await scriptedModel(answer)
  const child = spawn(
    process.execPath,
    [join(ultimateRoot, 'bin/ultimate.ts'), ultimateRoot, '--no-open'],
    {
      cwd: ultimateRoot,
      env: {
        ...cleanEnv(),
        ...model.env,
        HOME: home,
        ULTIMATE_HOME: home,
        ULTIMATE_PORT: '0',
        ULTIMATE_NO_OPEN: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(child)
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })
  return { child, ultimateRoot, output: () => output }
}
export async function fixture() {
  const home = await temp('ultimate-supervisor-')
  homes.push(home)
  const running = await launch(home)
  await until(() => running.output().includes('Ultimate: http://'))
  return { ...running, home, url: /Ultimate: (http:\/\/[^\s]+)/.exec(running.output())![1] }
}
export async function attach(url: string) {
  const stream = await attachStream(url)
  streams.push(stream)
  return stream
}
export async function activationFailure(root: string) {
  const file = join(root, 'server/main.ts')
  await writeFile(
    join(root, 'server/activation.ts'),
    "export async function failActivation(): Promise<void> { throw new Error('Injected activation failure') }\n",
  )
  await writeFile(
    file,
    "import { failActivation } from './activation.ts'\n" +
      (await readFile(file, 'utf8')).replace(
        'opened = harness\n',
        'opened = harness; await failActivation()\n',
      ),
  )
}
export function transcript(view: ConversationView) {
  return JSON.stringify(view.entries)
}
