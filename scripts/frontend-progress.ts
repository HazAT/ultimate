import { constants } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { isMissing } from '../lib/errors.ts'
import { git } from '../lib/git.ts'
import { spawnGroup, stopGroup } from '../lib/process-group.ts'
import { pace, within } from '../lib/timers.ts'
import { median, runsFlag } from './measure.ts'

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
const runs = runsFlag(args)
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
const readyMs = 120_000

const run = promisify(execFile)
const node = (script: string, scriptArgs: string[], cwd = here) =>
  run(process.execPath, [script, ...scriptArgs], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
  }).then(({ stdout }) => stdout)

const commit = await git(tree, 'rev-parse', '--short=8', 'HEAD')
if (await git(tree, 'status', '--porcelain', '--untracked-files=no'))
  throw new Error(`${tree} has uncommitted changes; measure a clean checkout`)
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

function assertPaused(database: string) {
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    const rows = db
      .prepare(
        `SELECT r.kind, r.content FROM document_revisions r JOIN documents d ON d.id = r.document_id
         WHERE d.kind = '"pause.state"' AND d.scope_kind = 'conversation' AND d.owner_id = 1
           AND d.retired_at IS NULL ORDER BY r.seq`,
      )
      .all() as { kind: string; content: string }[]
    let paused = false
    for (const { kind, content } of rows) {
      const value = JSON.parse(content) as { paused?: boolean } | [string, string[], unknown][]
      if (kind === 'base') paused = (value as { paused?: boolean }).paused === true
      else
        for (const [op, path, set] of value as [string, string[], unknown][])
          if (path[0] === 'paused') paused = op === 's' && set === true
    }
    if (!paused)
      throw new Error(`${database} is not paused: copy it with copy-paused.ts before measuring`)
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
    env: {
      PATH: [dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
      HOME: userHome,
      ULTIMATE_HOME: home,
      ULTIMATE_PROJECT: tree,
      ULTIMATE_USER_HOME: userHome,
      ULTIMATE_PORT: '0',
      ULTIMATE_NO_OPEN: '1',
      ULTIMATE_MODEL: 'scripted/scripted-1',
      PI_CODING_AGENT_DIR: agentDir,
      TAILSCALE_COMMAND: join(home, 'no-tailscale'),
    },
  })
  try {
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
    if (group.child.pid) await stopGroup(group.child.pid, { leader: group })
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
    const measured: Record<'median' | 'p95' | 'max' | 'taskMs' | 'events', number>[] = []
    for (let index = 0; index < runs; index++) {
      const line = (await node(join(skill, 'renders.ts'), [url, '1', '--send', prompt]))
        .split('\n')
        .find((row) => row.startsWith('{"ev":"ops"'))
      if (!line) throw new Error('The scripted turn streamed no ops events')
      const ops = JSON.parse(line) as {
        n: number
        taskMs: { median: number }
        renders: { median: number; p95: number; max: number }
      }
      measured.push({ ...ops.renders, taskMs: ops.taskMs.median, events: ops.n })
      console.error(`stream run ${index + 1}: ${JSON.stringify(measured.at(-1))}`)
    }
    const of = (key: keyof (typeof measured)[number]) => median(measured.map((row) => row[key]))
    return {
      median: of('median'),
      p95: of('p95'),
      max: of('max'),
      taskMs: of('taskMs'),
      events: of('events'),
    }
  })
}

function measurePreviews(home: string, agentDir: string) {
  return serve(
    home,
    agentDir,
    async (url) =>
      JSON.parse(
        await node(join(here, 'scripts/preview-bench.ts'), [url, '--runs', String(runs)]),
      ) as unknown,
  )
}

const weight = JSON.parse(await node(join(here, 'scripts/frontend-weight.ts'), [], tree)) as {
  rev: string
  dirty: boolean
  lines: { frontend: number; solid: number }
  perExtension: Record<string, { react: number; solid: number }>
  bundleKb: { jsGzip: number; entryAssetsGzip: number }
}
const scratch = await mkdtemp(join(tmpdir(), 'frontend-progress-'))
const model = scriptedModel()
const measured: Record<string, unknown> = {}
try {
  await new Promise<void>((listening) => model.listen(0, '127.0.0.1', listening))
  const agentDir = join(scratch, 'pi')
  await writeAgentDir(agentDir, (model.address() as AddressInfo).port)
  if (only.has('switch') && snapshot) {
    const home = join(scratch, 'switch')
    await mkdir(home)
    await copyFile(snapshot, join(home, 'state.sqlite'), constants.COPYFILE_FICLONE)
    assertPaused(join(home, 'state.sqlite'))
    measured.switch = await measureSwitch(home, agentDir)
  }
  if (only.has('stream')) measured.stream = await measureStream(join(scratch, 'stream'), agentDir)
  if (only.has('previews'))
    measured.previews = { scenarios: await measurePreviews(join(scratch, 'previews'), agentDir) }
} finally {
  await new Promise<void>((closed) => model.close(() => closed()))
  await rm(scratch, { recursive: true, force: true })
}
if (
  weight.dirty ||
  !commit.startsWith(weight.rev) ||
  (await git(tree, 'rev-parse', '--short=8', 'HEAD')) !== commit
)
  throw new Error(`${tree} moved or changed while it was measured; nothing written`)
const entry = {
  commit,
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
progress.entries = [
  ...progress.entries.filter((item) => item.commit !== entry.commit),
  merged,
].toSorted((a, b) => a.committedAt - b.committedAt)
await writeFile(progressFile, `${JSON.stringify(progress, null, 2)}\n`)
console.log(JSON.stringify(merged))
