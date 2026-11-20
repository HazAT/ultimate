import { constants, renameSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { apply } from '@earendil-works/chord/delta'
import type { JsonObject } from '@earendil-works/pi-durable'
import { execFile } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { browserBinary } from '../extensions/browser/server.ts'
import { isMissing } from '../lib/errors.ts'
import { git } from '../lib/git.ts'
import { spawnGroup, stopGroup } from '../lib/process-group.ts'
import { pace, within } from '../lib/timers.ts'
import { median, runsFlag } from './measure.ts'

const usage =
  'Usage: node scripts/frontend-progress.ts <tree> --label <label> [--summary <one line>] [--only switch,stream,previews] [--snapshot <paused state.sqlite>] [--runs 3]'
const args = process.argv.slice(2)
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
const tree = args[0] && resolve(args[0])
const label = flag('--label')
const summary = flag('--summary')
if (!tree || !label) throw new Error(usage)
const snapshot = flag('--snapshot')
const runs = runsFlag(args)
const only = new Set(flag('--only')?.split(','))
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
const readyMs = 120_000

const scratchParent = await realpath(tmpdir())
const fromHome = relative(await realpath(homedir()), scratchParent)
if (fromHome === '' || (fromHome.split(sep)[0] !== '..' && !isAbsolute(fromHome)))
  throw new Error(`${scratchParent} is inside ${homedir()}; point TMPDIR elsewhere`)
const chromium = resolve(await browserBinary())
const interruption = new AbortController()
const stops = new Set<() => unknown>()
const interrupt = () => {
  interruption.abort(new Error('Interrupted; nothing written'))
  for (const stop of stops) stop()
}
process.on('SIGINT', interrupt)
const stage = () => interruption.signal.throwIfAborted()
const scratch = await mkdtemp(join(scratchParent, 'frontend-progress-'))
const cleanEnv = (extra: Record<string, string>) => ({
  PATH: [dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
  HOME: join(scratch, 'home'),
  TMPDIR: scratch,
  ULTIMATE_CHROMIUM: chromium,
  ...extra,
})

const run = promisify(execFile)
const node = (script: string, scriptArgs: string[], cwd = here) =>
  run(process.execPath, [script, ...scriptArgs], {
    cwd,
    env: cleanEnv(cwd === tree ? { NODE_ENV: 'production' } : {}),
    signal: interruption.signal,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
  }).then(({ stdout }) => stdout)

const full = await git(tree, 'rev-parse', 'HEAD')
const unchanged = async () =>
  (await git(tree, 'rev-parse', 'HEAD')) === full &&
  !(await git(tree, 'status', '--porcelain', '--untracked-files=all'))
const commit = full.slice(0, 8)
const committedAt = Number(await git(tree, 'log', '-1', '--format=%ct'))

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

function scriptedModel() {
  return createServer((request, response) => {
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
}

async function writeAgentDir(dir: string, port: number) {
  await mkdir(dir, { recursive: true })
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
}

function assertManualPause(database: string) {
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    const rows = db
      .prepare(
        `SELECT r.kind, r.content FROM document_revisions r JOIN documents d ON d.id = r.document_id
         WHERE d.kind = '"pause.state"' AND d.scope_kind = 'conversation' AND d.owner_id = 1
           AND d.family = 0 AND d.retired_at IS NULL ORDER BY r.seq`,
      )
      .all() as { kind: string; content: string }[]
    let state: JsonObject = {}
    for (const { kind, content } of rows)
      state =
        kind === 'base' ? (JSON.parse(content) as JsonObject) : apply(state, JSON.parse(content))
    if (state.paused !== true || state.manual !== true)
      throw new Error(
        `${database} has no manual pause: copy it with copy-paused.ts before measuring`,
      )
  } finally {
    db.close()
  }
}

async function serve(home: string, agentDir: string, use: (url: string) => Promise<unknown>) {
  const userHome = join(home, 'user')
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  await writeFile(join(userHome, '.ultimate/onboarding.json'), '{"firstRunDone":true}')
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['claude-code'] } }),
  )
  const group = spawnGroup(process.execPath, ['server/main.ts'], {
    cwd: tree,
    env: cleanEnv({
      HOME: userHome,
      ULTIMATE_HOME: home,
      ULTIMATE_PROJECT: tree,
      ULTIMATE_USER_HOME: userHome,
      ULTIMATE_PORT: '0',
      ULTIMATE_NO_OPEN: '1',
      ULTIMATE_MODEL: 'scripted/scripted-1',
      PI_CODING_AGENT_DIR: agentDir,
      TAILSCALE_COMMAND: join(home, 'no-tailscale'),
    }),
  })
  const stop = () => stopGroup(group.child.pid!, { leader: group })
  const stopOnInterrupt = () => {
    stopping = stop()
  }
  let stopping: Promise<void> | undefined
  stops.add(stopOnInterrupt)
  try {
    stage()
    let output = ''
    const ready = new Promise<string>((serving, failed) => {
      const read = (data: Buffer) => {
        output += data.toString()
        const match = /^Ultimate: (http:\/\/127\.0\.0\.1:\d+)\r?$/m.exec(output)
        if (match) serving(match[1])
      }
      group.child.stdout.on('data', read)
      group.child.stderr.on('data', read)
      group.child.once('error', failed)
      group.child.once('exit', () => failed(new Error(`Server exited before serving:\n${output}`)))
    })
    const url = await within(
      readyMs,
      ready,
      () => new Error(`No server after ${readyMs} ms:\n${output}`),
    )
    return await use(url)
  } finally {
    stops.delete(stopOnInterrupt)
    if (group.child.pid) await (stopping ?? stop())
  }
}

function measureSwitch(home: string, agentDir: string) {
  return serve(home, agentDir, async (url) => {
    const cold: number[] = []
    const warm: number[] = []
    for (let index = 0; index < runs; index++) {
      const rows = (await node(join(skill, 'switch.ts'), [url, '1', switchIds, '--rounds', '3']))
        .split('\n')
        .filter((line) => line.startsWith('{"round"'))
        .map((line) => JSON.parse(line) as { round: number; settledMs: number })
      cold.push(median(rows.filter((row) => row.round === 0).map((row) => row.settledMs)))
      warm.push(median(rows.filter((row) => row.round > 0).map((row) => row.settledMs)))
      console.error(`switch run ${index + 1}: cold ${cold.at(-1)} warm ${warm.at(-1)}`)
    }
    return { cold: median(cold), warm: median(warm) }
  })
}

function measureStream(home: string, agentDir: string) {
  return serve(home, agentDir, async (url) => {
    const measured: Record<
      'median' | 'p95' | 'max' | 'taskMs' | 'taskP95Ms' | 'mutations' | 'mutationsP95' | 'events',
      number
    >[] = []
    for (let index = 0; index < runs; index++) {
      const line = (await node(join(skill, 'renders.ts'), [url, '1', '--send', prompt]))
        .split('\n')
        .find((row) => row.startsWith('{"ev":"ops"'))
      if (!line) throw new Error('The scripted turn streamed no ops events')
      const ops = JSON.parse(line) as {
        n: number
        taskMs: { median: number; p95: number }
        mutations: { median: number; p95: number }
        renders: { median: number; p95: number; max: number }
      }
      measured.push({
        ...ops.renders,
        taskMs: ops.taskMs.median,
        taskP95Ms: ops.taskMs.p95,
        mutations: ops.mutations.median,
        mutationsP95: ops.mutations.p95,
        events: ops.n,
      })
      console.error(`stream run ${index + 1}: ${JSON.stringify(measured.at(-1))}`)
    }
    const of = (key: keyof (typeof measured)[number]) => median(measured.map((row) => row[key]))
    return {
      median: of('median'),
      p95: of('p95'),
      max: of('max'),
      taskMs: of('taskMs'),
      taskP95Ms: of('taskP95Ms'),
      mutations: of('mutations'),
      mutationsP95: of('mutationsP95'),
      events: of('events'),
    }
  })
}

function measurePreviews(home: string, agentDir: string) {
  return serve(home, agentDir, async (url) => {
    await writeFile(join(home, 'benchmark-host'), url)
    return JSON.parse(
      await node(join(here, 'scripts/preview-bench.ts'), [home, '--runs', String(runs)]),
    ) as unknown
  })
}

type Weight = {
  rev: string
  dirty: boolean
  lines: { frontend: number; solid: number }
  perExtension: Record<string, { react: number; solid: number }>
  bundleKb: { jsGzip: number; entryAssetsGzip: number }
}
let weight: Weight | undefined
const model = scriptedModel()
const measured: Record<string, unknown> = {}
stops.add(() => model.close())
try {
  if (!(await unchanged()))
    throw new Error(`${tree} has uncommitted or untracked changes; measure a clean checkout`)
  weight = JSON.parse(await node(join(here, 'scripts/frontend-weight.ts'), [], tree)) as Weight
  stage()
  await new Promise<void>((listening, failed) => {
    model.once('error', failed)
    model.listen(0, '127.0.0.1', listening)
  })
  const agentDir = join(scratch, 'pi')
  await writeAgentDir(agentDir, (model.address() as AddressInfo).port)
  if (only.has('switch')) {
    if (!snapshot) throw new Error(`--only switch needs --snapshot\n${usage}`)
    const home = join(scratch, 'switch')
    await mkdir(home)
    await copyFile(snapshot, join(home, 'state.sqlite'), constants.COPYFILE_FICLONE)
    assertManualPause(join(home, 'state.sqlite'))
    measured.switch = await measureSwitch(home, agentDir)
  }
  stage()
  if (only.has('stream')) measured.stream = await measureStream(join(scratch, 'stream'), agentDir)
  stage()
  if (only.has('previews'))
    measured.previews = { scenarios: await measurePreviews(join(scratch, 'previews'), agentDir) }
  stage()
} finally {
  if (model.listening) await new Promise<void>((closed) => model.close(() => closed()))
  await rm(scratch, { recursive: true, force: true })
}
if (!weight || weight.dirty || !full.startsWith(weight.rev) || !(await unchanged()))
  throw new Error(`${tree} moved or changed while it was measured; nothing written`)
const entry = {
  commit,
  sha: full,
  label,
  date: new Date(committedAt * 1000).toISOString().slice(0, 10),
  committedAt,
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
const progress = JSON.parse(stored) as Record<string, unknown> & { entries: Entry[] }
const same = (item: Entry) => item.sha === full
const previous = progress.entries.find(same)
const merged: Entry = {
  switch: null,
  stream: null,
  previews: null,
  ...previous,
  ...entry,
  ...(summary ? { summary } : {}),
  ...measured,
  ...(measured.previews && previous?.previews
    ? { previews: { ...previous.previews, ...measured.previews } }
    : {}),
}
progress.entries = previous
  ? progress.entries.map((item) => (same(item) ? merged : item))
  : [...progress.entries, merged]
const staged = `${progressFile}.${process.pid}`
try {
  await writeFile(staged, `${JSON.stringify(progress, null, 2)}\n`)
  stage()
  renameSync(staged, progressFile)
} finally {
  await rm(staged, { force: true })
}
process.off('SIGINT', interrupt)
console.log(JSON.stringify(merged))
