import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { afterEach, expect, it, vi } from 'vitest'
import { git } from '../../../../lib/git.ts'
import { spawn } from 'node:child_process'
import { temp } from '../../../../test/helpers.ts'
import { probe } from '../../availability.ts'
import { confinedExec, prepareRun } from '../../layout.ts'
import { startProxy } from '../../proxy.ts'

const bridge = join(dirname(fileURLToPath(import.meta.url)), '../../bridge.cjs')
const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com']
const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).toReversed()) await fn()
})

const unavailable = async () => {
  const bwrap = await probe().catch((error: unknown) => error)
  if (!(bwrap instanceof Error)) return undefined
  expect(bwrap.message).toMatch(/^Sandbox unavailable:/)
  expect(bwrap.message).toContain('apparmor')
  return bwrap
}

async function listen(): Promise<{ port: number; echo: Server }> {
  const echo = createServer((socket) => socket.pipe(socket))
  echo.listen(0, '127.0.0.1')
  await once(echo, 'listening')
  cleanup.push(() => new Promise((resolve) => echo.close(resolve)))
  return { port: (echo.address() as { port: number }).port, echo }
}

async function scene(options: { proxy?: string[] } = {}) {
  const bwrap = await probe()
  const root = await temp('sbx-', '/var/tmp')
  const repo = join(root, 'repo')
  const wt = join(root, 'wt')
  const state = join(root, 'state')
  await mkdir(repo)
  await git(repo, 'init', '-q', '-b', 'main')
  for (const name of ['one', 'two', 'three']) {
    await writeFile(join(repo, name), name)
    await git(repo, 'add', name)
    await git(repo, ...identity, 'commit', '-q', '-m', name)
  }
  await git(repo, 'tag', 'v1')
  await git(repo, 'branch', 'second')
  await git(repo, 'worktree', 'add', '-q', '-b', 'ultimate/w-1', wt)
  const run = await prepareRun(state, 7, { path: wt, branch: 'ultimate/w-1' })
  const proxy = options.proxy
    ? await (async () => {
        const socket = join(root, 'p.sock')
        const started = await startProxy(socket, options.proxy!)
        cleanup.push(() => started.close())
        return { socket, bridge }
      })()
    : undefined
  const sh = async (command: string, extra: { env?: Record<string, string> } = {}) => {
    let out = ''
    const result = await confinedExec(
      run,
      { program: bwrap, ...(proxy ? { proxy } : {}), inTurn: (op) => op() },
      new NodeExecutionEnv({ cwd: run.worktree }),
      command,
      { onOutput: (text) => (out += text), timeout: 30, ...extra },
      BACKGROUND_CONTEXT,
    )
    if (!result.ok) throw result.error
    return { out, code: result.value.exitCode }
  }
  const worktreeName = basename(run.worktreeGitDir)
  return {
    root,
    repo,
    wt,
    run,
    sh,
    common: run.common,
    worktreeName,
    git: (...a: string[]) => git(wt, ...a),
  }
}
type Scene = Awaited<ReturnType<typeof scene>>

const sha = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
const present = async (path: string) => (await stat(path).catch(() => undefined)) && path

async function snapshot(s: Scene) {
  const refs = (await git(s.repo, 'for-each-ref', '--format=%(objectname) %(refname)'))
    .split('\n')
    .filter((line) => !line.endsWith(' refs/heads/ultimate/w-1'))
  const files: Record<string, string | null> = {}
  const own = join(s.common, 'worktrees', s.worktreeName)
  const watched = [
    join(s.common, 'config'),
    join(s.common, 'HEAD'),
    join(s.common, 'packed-refs'),
    join(s.common, 'commondir'),
    join(s.common, 'objects/info/alternates'),
    join(s.wt, '.git'),
    ...['commondir', 'gitdir', 'HEAD'].map((file) => join(own, file)),
  ]
  for (const folder of ['hooks', 'info'])
    for (const file of await readdir(join(s.common, folder)).catch(() => []))
      watched.push(join(s.common, folder, file))
  for (const path of watched) files[path] = (await present(path)) ? await sha(path) : null
  const objects: Record<string, string> = {}
  for (const dir of await readdir(join(s.common, 'objects')))
    if (/^[0-9a-f]{2}$/.test(dir))
      for (const file of await readdir(join(s.common, 'objects', dir)))
        objects[`${dir}/${file}`] = await sha(join(s.common, 'objects', dir, file))
  return { refs, files, objects }
}

async function intact(s: Scene, before: Awaited<ReturnType<typeof snapshot>>) {
  const after = await snapshot(s)
  expect(after.refs).toEqual(before.refs)
  expect(after.files).toEqual(before.files)
  for (const [path, hash] of Object.entries(before.objects)) expect(after.objects[path]).toBe(hash)
  expect(
    await git(s.repo, 'fsck', '--no-dangling', '--no-progress').catch((e: Error) => e.message),
  ).not.toMatch(/error|missing|corrupt|broken/i)
  expect(await git(s.wt, 'status', '--porcelain')).toBe('')
}

const begin = async () => ((await unavailable()) ? undefined : scene())

it('hides host files, sockets and secrets', async () => {
  const s = await begin()
  if (!s) return
  const decoy = join(s.root, 'decoy.txt')
  await writeFile(decoy, 'decoy')
  const checks = [
    decoy,
    join(homedir(), '.ssh'),
    join(homedir(), '.ultimate'),
    '/var/run/docker.sock',
    `/run/user/${process.getuid!()}/bus`,
  ]
  const { out, code } = await s.sh(
    checks.map((path) => `test -e '${path}' && echo "PRESENT ${path}"`).join('\n') + '\necho done',
  )
  expect(out).toBe('done\n')
  expect(code).toBe(0)
})

it('refuses TCP to a host listener and fails DNS', async () => {
  const s = await begin()
  if (!s) return
  const { port } = await listen()
  const tcp = await s.sh(`exec 3<>/dev/tcp/127.0.0.1/${port}`)
  expect(tcp.code).not.toBe(0)
  const dns = await s.sh('getent hosts example.com')
  expect(dns.code).not.toBe(0)
})

it('cannot see or signal a process outside', async () => {
  const s = await begin()
  if (!s) return
  const sleeper = spawn('sleep', ['99991'], { stdio: 'ignore' })
  cleanup.push(() => sleeper.kill())
  const pid = sleeper.pid!
  const { out } = await s.sh(
    `kill -0 ${pid} 2>/dev/null && echo SIGNALLED; test -e /proc/${pid} && echo VISIBLE; echo done`,
  )
  expect(out).toBe('done\n')
  expect(() => process.kill(pid, 0)).not.toThrow()
})

it('drops capabilities and refuses new user namespaces', async () => {
  const s = await begin()
  if (!s) return
  const caps = await s.sh(`grep CapEff /proc/self/status`)
  expect(caps.out.trim()).toMatch(/^CapEff:\s+0+$/)
  expect((await s.sh('unshare -r true')).code).not.toBe(0)
})

it('clears the environment and discards writes to /tmp', async () => {
  const s = await begin()
  if (!s) return
  vi.stubEnv('SANDBOX_TEST_DECOY', 'leak')
  const { out } = await s.sh(
    'env | grep -c SANDBOX_TEST_DECOY; echo x > /tmp/sbx-marker-4711; ls /tmp',
  )
  expect(out).toContain('0\n')
  expect(out).toContain('sbx-marker-4711')
  expect(await present('/tmp/sbx-marker-4711')).toBeFalsy()
  expect(await s.sh('test -e /tmp/sbx-marker-4711')).toMatchObject({ code: 1 })
})

it('kills a background process when the call ends', async () => {
  const s = await begin()
  if (!s) return
  await s.sh('nohup sleep 99992 >/dev/null 2>&1 &\ntest -d /proc/1')
  const { out } = await s.sh(
    'for p in /proc/[0-9]*; do cat $p/comm 2>/dev/null; done | grep -c "^sleep$"; true',
  )
  expect(out.trim()).toBe('0')
  const found = await new Promise<string>((resolve) => {
    const child = spawn('pgrep', ['-x', '-f', 'sleep 99992'])
    let text = ''
    child.stdout.on('data', (chunk) => (text += chunk))
    child.on('close', () => resolve(text))
  })
  expect(found.trim()).toBe('')
})

const gitAttempts: [string, (s: Scene) => string][] = [
  [
    'writes .git/config, a hook and info/exclude',
    (s) =>
      `echo '[core]' >> ${s.common}/config; echo x > ${s.common}/hooks/post-commit; echo x >> ${s.common}/info/exclude; echo x > ${s.common}/hooks/new`,
  ],
  [
    'rewrites and removes the worktree commondir and gitdir',
    (s) => {
      const own = `${s.common}/worktrees/${s.worktreeName}`
      return `echo /elsewhere > ${own}/commondir; echo /elsewhere > ${own}/gitdir; rm -f ${own}/commondir ${own}/gitdir`
    },
  ],
  [
    'writes the worktree .git pointer',
    (s) => `echo 'gitdir: /elsewhere' > ${s.wt}/.git; rm -f ${s.wt}/.git`,
  ],
  [
    'writes objects/info/alternates',
    (s) =>
      `echo /elsewhere > ${s.common}/objects/info/alternates; rm -f ${s.common}/objects/info/alternates`,
  ],
  [
    'writes under the object mount',
    () => `echo x > /run/ultimate/git-objects/planted; mkdir /run/ultimate/git-objects/zz`,
  ],
  [
    'updates other branches',
    () => `git update-ref refs/heads/main HEAD~1; git update-ref refs/heads/second HEAD~2`,
  ],
  [
    'points the worktree HEAD at main and commits',
    (s) =>
      `echo 'ref: refs/heads/main' > ${s.common}/worktrees/${s.worktreeName}/HEAD; echo x > f; git add f; git -c user.name=T -c user.email=t@e.com commit -q -m evil; rm -f f`,
  ],
  [
    'plants a corrupt loose object over an existing hash',
    (s) =>
      `h=$(git rev-parse HEAD); d=${s.common}/objects/\${h:0:2}; mkdir -p $d; rm -f $d/\${h:2}; echo garbage > $d/\${h:2}; chmod 644 $d/\${h:2}`,
  ],
  ['creates a tag', () => `git tag evil; git tag -f v1 HEAD~1`],
  ['creates commondir in the common directory', (s) => `echo x > ${s.common}/commondir`],
]
for (const [name, command] of gitAttempts)
  it(`leaves the real repository unchanged when the sandbox ${name}`, async () => {
    const s = await begin()
    if (!s) return
    const before = await snapshot(s)
    const { code } = await s.sh(command(s))
    expect(code).toBeTypeOf('number')
    await intact(s, before)
  })

it('brings a commit back to the real branch', async () => {
  const s = await begin()
  if (!s) return
  const { out } = await s.sh(
    `echo hi > new.txt; git add new.txt; git -c user.name=T -c user.email=t@e.com commit -q -m inside; git rev-parse HEAD`,
  )
  const tip = out.trim().split('\n').at(-1)
  expect(tip).toMatch(/^[0-9a-f]{40}$/)
  expect(await git(s.repo, 'rev-parse', 'refs/heads/ultimate/w-1')).toBe(tip)
  expect(await git(s.wt, 'status', '--porcelain')).toBe('')
  expect(await readFile(join(s.wt, 'new.txt'), 'utf8')).toBe('hi\n')
})

it('reports commits it cannot bring back and keeps the last good tip', async () => {
  const s = await begin()
  if (!s) return
  const good = await git(s.repo, 'rev-parse', 'refs/heads/ultimate/w-1')
  const { out } = await s.sh(
    `echo hi > new.txt; git add new.txt; git -c user.name=T -c user.email=t@e.com commit -q -m inside
h=$(git rev-parse HEAD); f=${s.common}/objects/\${h:0:2}/\${h:2}; rm -f $f; echo garbage > $f`,
  )
  expect(out).toContain('[sandbox] commits could not be brought back')
  expect(await git(s.repo, 'rev-parse', 'refs/heads/ultimate/w-1')).toBe(good)
  await git(s.repo, 'fsck', '--no-dangling')
})

it('never writes through links the sandbox planted in its shadow refs', async () => {
  const s = await begin()
  if (!s) return
  const decoys = join(s.root, 'decoys')
  await mkdir(decoys)
  await writeFile(join(decoys, 'file'), 'decoy')
  await s.sh(
    `rm -rf ${s.common}/refs/heads/ultimate && ln -s ${decoys} ${s.common}/refs/heads/ultimate
rm -rf ${s.common}/logs && mkdir ${s.common}/logs && ln -s ${decoys}/file ${s.common}/logs/HEAD`,
  )
  await git(s.wt, ...identity, 'commit', '-q', '--allow-empty', '-m', 'host moved the branch')
  const { code } = await s.sh('git log --oneline -1')
  expect(code).toBe(0)
  expect(await readdir(decoys)).toEqual(['file'])
  expect(await readFile(join(decoys, 'file'), 'utf8')).toBe('decoy')
})

const connectThrough = (target: string) =>
  `exec 3<>/dev/tcp/127.0.0.1/3128; printf 'CONNECT ${target} HTTP/1.1\\r\\nHost: ${target}\\r\\n\\r\\nping\\n' >&3; while read -r -t 5 line <&3; do echo "$line"; [ "$line" = ping ] && break; done`

it('reaches only allowed hosts through the proxy bridge', async () => {
  if (await unavailable()) return
  const { port } = await listen()
  const s = await scene({ proxy: [`127.0.0.1:${port}`] })
  const allowed = await s.sh(connectThrough(`127.0.0.1:${port}`))
  expect(allowed.out).toContain('200 Connection Established')
  expect(allowed.out).toContain('ping')
  const denied = await s.sh(connectThrough(`127.0.0.1:${port + 1}`))
  expect(denied.out).toContain('403')
  expect(denied.out).not.toContain('ping')
  const direct = await s.sh(`exec 3<>/dev/tcp/127.0.0.1/${port}`)
  expect(direct.code).not.toBe(0)
})

it('fails closed when bwrap is not installed', async () => {
  vi.stubEnv('PATH', await temp('sbx-nobwrap-'))
  await expect(probe()).rejects.toThrow(/^Sandbox unavailable: bwrap is not installed/)
})

it('fails closed with the stderr of a bwrap that cannot create namespaces', async () => {
  const folder = await temp('sbx-stub-')
  await writeFile(
    join(folder, 'bwrap'),
    '#!/bin/sh\necho "bwrap: setting up uid map: Permission denied" >&2\nexit 1\n',
  )
  await chmod(join(folder, 'bwrap'), 0o755)
  vi.stubEnv('PATH', folder)
  await expect(probe()).rejects.toThrow('bwrap: setting up uid map: Permission denied')
  await expect(probe()).rejects.toThrow(/^Sandbox unavailable:/)
})
