import { constants } from 'node:fs'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isMissing } from '../lib/errors.ts'
import { git } from '../lib/git.ts'
import { spawnGroup, stopGroup } from '../lib/process-group.ts'
import { pace } from '../lib/timers.ts'

const usage =
  'Usage: node scripts/frontend-progress.ts <tree> --label <label> [--snapshot <paused state.sqlite>] [--runs 3] [--only switch,stream,previews]'
const args = process.argv.slice(2)
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
const tree = args[0] && resolve(args[0])
const label = flag('--label')
if (!tree || !label) throw new Error(usage)
const snapshot = flag('--snapshot')
const runs = Number(flag('--runs') ?? 3)
const only = new Set((flag('--only') ?? 'switch,stream,previews').split(','))
const here = resolve(import.meta.dirname, '..')
const skill = join(here, '.ultimate/skills/measure-switch')
const progressFile = join(here, 'docs/frontend-progress.json')
const switchIds = '30726,97078,171689,32858'
const prompt = 'Stream the scripted reply.'
const streamChunks = Array.from(
  { length: 40 },
  (_, index) => `Paragraph ${Math.floor(index / 8) + 1}, sentence ${(index % 8) + 1}. `,
)
const streamBeatMs = 60

const run = promisify(execFile)
const median = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) / 2)]
const node = (script: string, scriptArgs: string[], cwd = here) =>
  run(process.execPath, [script, ...scriptArgs], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
  }).then(({ stdout }) => stdout)

const chunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: 'scripted',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'scripted-1',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`

const textOf = (content: unknown) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part: { text?: string }) => part.text ?? '').join('')
      : ''

async function scriptedModel(dir: string) {
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (data) => (body += data))
    request.on('end', async () => {
      const { messages } = JSON.parse(body) as { messages: { role: string; content: unknown }[] }
      const last = messages.at(-1)!
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (last.role === 'user' && textOf(last.content) === prompt)
        for (const text of streamChunks) {
          response.write(chunk({ role: 'assistant', content: text }))
          await pace(streamBeatMs)
        }
      else response.write(chunk({ role: 'assistant', content: 'Scripted.' }))
      response.write(chunk({}, 'stop'))
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening))
  const { port } = server.address() as AddressInfo
  await writeFile(
    join(dir, 'models.json'),
    JSON.stringify({
      providers: {
        scripted: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: 'openai-completions',
          apiKey: 'scripted',
          models: [{ id: 'scripted-1' }],
        },
      },
    }),
  )
  await writeFile(
    join(dir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'scripted', defaultModel: 'scripted-1' }),
  )
  return { close: () => new Promise<void>((closed) => server.close(() => closed())) }
}

async function serve(home: string, agentDir: string) {
  const userHome = join(home, 'user')
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  await writeFile(join(userHome, '.ultimate/onboarding.json'), '{"firstRunDone":true}')
  for (const name of await readdir(homedir()))
    if (name !== '.ultimate' && !name.startsWith('.frontend-progress-'))
      await symlink(join(homedir(), name), join(userHome, name))
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('ULTIMATE_')),
    ),
    ULTIMATE_HOME: home,
    ULTIMATE_PROJECT: tree,
    HOME: userHome,
    ULTIMATE_USER_HOME: userHome,
    ULTIMATE_PORT: '0',
    ULTIMATE_NO_OPEN: '1',
    ULTIMATE_MODEL: 'scripted/scripted-1',
    PI_CODING_AGENT_DIR: agentDir,
    TAILSCALE_COMMAND: join(home, 'no-tailscale'),
  }
  const group = spawnGroup(process.execPath, ['server/main.ts'], { cwd: tree, env })
  let output = ''
  const url = await new Promise<string>((ready, failed) => {
    const read = (data: Buffer) => {
      output += data.toString()
      const match = /^Ultimate: (http:\/\/127\.0\.0\.1:\d+)\r?$/m.exec(output)
      if (match) ready(match[1])
    }
    group.child.stdout.on('data', read)
    group.child.stderr.on('data', read)
    group.child.once('exit', () => failed(new Error(`Server exited before serving:\n${output}`)))
  })
  return { url, stop: () => stopGroup(group.child.pid!, { leader: group }) }
}

async function measureSwitch(home: string, agentDir: string) {
  await mkdir(home, { recursive: true })
  await copyFile(snapshot!, join(home, 'state.sqlite'), constants.COPYFILE_FICLONE)
  const server = await serve(home, agentDir)
  try {
    const state = await fetch(`${server.url}/api/extensions/pause/actions/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body: '{"args":null}',
    }).then((response) => response.json() as Promise<{ result: { paused: boolean } }>)
    if (!state.result.paused) throw new Error('The snapshot copy is not paused; stopped it')
    const cold: number[] = []
    const warm: number[] = []
    for (let index = 0; index < runs; index++) {
      const rows = (
        await node(join(skill, 'switch.ts'), [server.url, '1', switchIds, '--rounds', '3'])
      )
        .split('\n')
        .filter((line) => line.startsWith('{"round"'))
        .map((line) => JSON.parse(line) as { round: number; settledMs: number })
      cold.push(median(rows.filter((row) => row.round === 0).map((row) => row.settledMs)))
      warm.push(median(rows.filter((row) => row.round > 0).map((row) => row.settledMs)))
      console.error(`switch run ${index + 1}: cold ${cold.at(-1)} warm ${warm.at(-1)}`)
    }
    return { cold: median(cold), warm: median(warm) }
  } finally {
    await server.stop()
  }
}

async function measureStream(home: string, agentDir: string) {
  await mkdir(home, { recursive: true })
  const server = await serve(home, agentDir)
  try {
    const measured: { median: number; p95: number; max: number; taskMs: number; n: number }[] = []
    for (let index = 0; index < runs; index++) {
      const line = (await node(join(skill, 'renders.ts'), [server.url, '1', '--send', prompt]))
        .split('\n')
        .find((row) => row.startsWith('{"ev":"ops"'))
      if (!line) throw new Error('The scripted turn streamed no ops events')
      const ops = JSON.parse(line) as {
        n: number
        taskMs: { median: number }
        renders: { median: number; p95: number; max: number }
      }
      measured.push({ ...ops.renders, taskMs: ops.taskMs.median, n: ops.n })
      console.error(`stream run ${index + 1}: ${JSON.stringify(measured.at(-1))}`)
    }
    const of = (key: 'median' | 'p95' | 'max' | 'taskMs' | 'n') =>
      median(measured.map((row) => row[key]))
    return {
      median: of('median'),
      p95: of('p95'),
      max: of('max'),
      taskMs: of('taskMs'),
      events: of('n'),
    }
  } finally {
    await server.stop()
  }
}

async function measurePreviews(home: string, agentDir: string) {
  await mkdir(home, { recursive: true })
  const server = await serve(home, agentDir)
  try {
    return JSON.parse(
      await node(join(here, 'scripts/preview-bench.ts'), [server.url, '--runs', String(runs)]),
    ) as unknown
  } finally {
    await server.stop()
  }
}

const weight = JSON.parse(await node(join(here, 'scripts/frontend-weight.ts'), [], tree)) as {
  lines: { frontend: number; solid: number }
  perExtension: Record<string, { react: number; solid: number }>
  bundleKb: { jsGzip: number; entryAssetsGzip: number }
}
const scratch = await mkdtemp(join(homedir(), '.frontend-progress-'))
const agentDir = join(scratch, 'pi')
await mkdir(agentDir)
const model = await scriptedModel(agentDir)
const measured: Record<string, unknown> = {}
try {
  if (only.has('switch') && snapshot)
    measured.switch = await measureSwitch(join(scratch, 'switch'), agentDir)
  if (only.has('stream')) measured.stream = await measureStream(join(scratch, 'stream'), agentDir)
  if (only.has('previews'))
    measured.previews = { scenarios: await measurePreviews(join(scratch, 'previews'), agentDir) }
} finally {
  await model.close()
  await rm(scratch, { recursive: true, force: true })
}
const entry = {
  commit: await git(tree, 'rev-parse', '--short=8', 'HEAD'),
  label,
  date: await git(tree, 'log', '-1', '--format=%cs'),
  lines: {
    total: weight.lines.frontend,
    solid: weight.lines.solid,
    react: weight.lines.frontend - weight.lines.solid,
  },
  perExtension: weight.perExtension,
  bundleGzipKB: weight.bundleKb.jsGzip,
  entryGzipKB: weight.bundleKb.entryAssetsGzip,
}
const stored = await readFile(progressFile, 'utf8').catch((error: unknown) => {
  if (isMissing(error)) return '{"entries":[]}'
  throw error
})
type Entry = typeof entry & Record<string, unknown>
const progress = JSON.parse(stored) as { entries: Entry[] }
const order = async (commit: string) => Number(await git(here, 'log', '-1', '--format=%ct', commit))
const previous = progress.entries.find((item) => item.commit === entry.commit)
const merged: Entry = {
  switch: null,
  stream: null,
  previews: null,
  ...previous,
  ...entry,
  ...measured,
  ...(measured.previews && previous?.previews
    ? { previews: { ...previous.previews, ...measured.previews } }
    : {}),
}
const entries = [...progress.entries.filter((item) => item.commit !== entry.commit), merged]
const times = new Map(
  await Promise.all(entries.map(async (item) => [item.commit, await order(item.commit)] as const)),
)
progress.entries = entries.toSorted((a, b) => times.get(a.commit)! - times.get(b.commit)!)
await writeFile(progressFile, `${JSON.stringify(progress, null, 2)}\n`)
console.log(JSON.stringify(merged))
