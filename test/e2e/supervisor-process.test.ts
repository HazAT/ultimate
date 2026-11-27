import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { connect } from 'node:net'
import { temp, sourceCopy, cleanEnv, until, post } from '../helpers.ts'
import { children, homes, copies, launch, fixture, attach } from './supervisor-helpers.ts'
it('starts past stale lock sidecars without killing an unrelated live pid', async () => {
  const home = await temp('ultimate-stale-supervisor-')
  homes.push(home)
  const unrelated = spawn('sleep', ['60'])
  children.push(unrelated)
  await writeFile(join(home, 'ultimate.lock'), JSON.stringify({ pid: 2147483647 }))
  await writeFile(join(home, 'storage.lock'), JSON.stringify({ pid: unrelated.pid }))
  const running = await launch(home)
  await until(() => running.output().includes('Ultimate: http://'))
  // Without Tailscale there is no remote origin and nothing about one.
  expect(running.output()).not.toContain('(remote)')
  expect(unrelated.exitCode).toBeNull()
  expect(unrelated.signalCode).toBeNull()
  expect(() => process.kill(unrelated.pid!, 0)).not.toThrow()
}, 60000)

it('logs each remote URL when it is registered and when it is no longer served', async () => {
  const home = await temp('ultimate-access-log-')
  homes.push(home)
  const root = await sourceCopy(home)
  copies.set(home, root)
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['tailscale'] } }),
  )
  // Real access registration, without touching the machine's Tailscale Serve mappings.
  await writeFile(
    join(root, 'extensions/tailscale/server.ts'),
    `import { defineExtension } from '@earendil-works/pi-durable'
let remove: (() => void) | undefined
export default function fixture(host: import('../../server/extensions.ts').ExtensionHost) {
  host.onOpen(async () => {
    remove = host.access.allow({ origin: 'https://rog.example.ts.net:5799', verify: () => ({ login: 'owner' }) })
  })
  return defineExtension({ name: 'tailscale' })
}
export const actions = { revoke: async () => { remove?.(); return true } }
`,
  )
  const running = await launch(home)
  // Registration happens while the extensions open, so the remote line may come before the local one.
  await until(
    () =>
      running.output().includes('Ultimate: https://rog.example.ts.net:5799 (remote)') &&
      running.output().includes('Ultimate: http://'),
  )
  const url = /Ultimate: (http:\/\/[^\s]+)/.exec(running.output())![1]
  expect((await post(url, '/api/extensions/tailscale/actions/revoke', { args: null })).status).toBe(
    200,
  )
  await until(() =>
    running
      .output()
      .includes('Ultimate: https://rog.example.ts.net:5799 (remote) is no longer served'),
  )
}, 60000)

describe('supervisor process ownership', () => {
  it('keeps crash diagnostics private to direct loopback requests', async () => {
    const home = await temp('ultimate-crash-page-')
    homes.push(home)
    const root = await sourceCopy(home)
    copies.set(home, root)
    await writeFile(join(root, 'server/main.ts'), "throw new Error('private stderr marker')\n")
    await launch(home)
    let url = ''
    await until(async () => {
      try {
        const lock = JSON.parse(await readFile(join(home, 'ultimate.lock'), 'utf8'))
        if (lock.port) url = `http://127.0.0.1:${lock.port}`
        return Boolean(url)
      } catch {
        return false
      }
    })
    const local = await fetch(url)
    expect(local.status).toBe(503)
    expect(await local.text()).toContain('private stderr marker')
    for (const headers of [
      { 'x-forwarded-for': '100.1.2.3' },
      { 'x-forwarded-host': 'remote.example' },
      { forwarded: '' },
      { host: 'remote.example:4799' },
    ]) {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(url, { headers }, (res) => {
          let body = ''
          res.on('data', (chunk) => {
            body += chunk
          })
          res.on('end', () => resolve({ status: res.statusCode!, body }))
        })
        req.on('error', reject)
        req.end()
      })
      expect(response.status).toBe(503)
      expect(response.body).toBe('')
    }
    const port = Number(new URL(url).port)
    const idle = connect(port, '127.0.0.1')
    await once(idle, 'connect')
    idle.resume()
    const started = Date.now()
    await once(idle, 'close')
    expect(Date.now() - started).toBeLessThan(8000)
    const delayed = connect(port, '127.0.0.1')
    await once(delayed, 'connect')
    delayed.write('GET /api/models HTTP/1.1\r\n')
    await writeFile(
      join(root, 'server/main.ts'),
      `import { createServer } from 'node:http'
const server=createServer((_req,res)=>res.end('recovered'))
server.listen(0,'127.0.0.1',()=>process.send?.({type:'prepared',port:(server.address() as import('node:net').AddressInfo).port}))
process.on('message',(message:{type:string})=>{ if(message.type==='go')process.send?.({type:'ready'}); if(message.type==='release')process.send?.({type:'released'}); if(message.type==='exit')server.close(()=>process.exit(0)) })`,
    )
    await until(async () => {
      try {
        return (await fetch(url)).status === 200
      } catch {
        return false
      }
    })
    const received = new Promise<string>((resolve, reject) => {
      let wire = ''
      delayed.on('data', (chunk) => {
        wire += chunk
      })
      delayed.on('end', () => resolve(wire))
      delayed.on('error', reject)
    })
    delayed.write(`Host: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`)
    expect(await received).toContain('200 OK')
  }, 60000)

  it('stops restarting a core that keeps crashing soon after it is ready', async () => {
    const home = await temp('ultimate-crash-loop-')
    homes.push(home)
    const root = await sourceCopy(home)
    copies.set(home, root)
    await writeFile(
      join(root, 'server/main.ts'),
      `import { createServer } from 'node:http'
const server=createServer((_req,res)=>res.end('up'))
server.listen(0,'127.0.0.1',()=>process.send?.({type:'prepared',port:(server.address() as import('node:net').AddressInfo).port}))
process.on('message',(message:{type:string})=>{ if(message.type==='go'){process.send?.({type:'ready'});setTimeout(()=>void Promise.reject(new Error('background promise failed')),100)} })`,
    )
    const running = await launch(home)
    await until(() => running.output().includes('failed · waiting for changes'))
    expect(running.output().match(/exited unexpectedly/g)).toHaveLength(3)
    const lock = JSON.parse(await readFile(join(home, 'ultimate.lock'), 'utf8'))
    const page = await fetch(`http://127.0.0.1:${lock.port}`)
    expect(page.status).toBe(503)
    expect(await page.text()).toContain('background promise failed')
  }, 60000)

  it('owns a random public port, refuses a second instance naming its pid, and accepts the public Origin', async () => {
    const first = await fixture()
    const second = await launch(first.home)
    const [code] = await once(second.child, 'exit')
    expect(code).not.toBe(0)
    expect(second.output()).toContain(
      `Ultimate is already running (pid ${first.child.pid}) at ${first.url}`,
    )
    expect(JSON.parse(await readFile(join(first.home, 'ultimate.lock'), 'utf8'))).toEqual({
      pid: first.child.pid,
      port: Number(new URL(first.url).port),
      project: first.ultimateRoot,
    })
    const stream = await attach(first.url)
    expect(stream.system().process.url).toBe(first.url)
    expect(
      (
        await fetch(first.url + '/api/restart', {
          method: 'POST',
          headers: { Origin: 'https://example.com' },
        })
      ).status,
    ).toBe(403)
    expect(
      (await post(first.url, '/api/conversations/1/configure', { thinkingLevel: 'off' })).status,
    ).toBe(200)
  }, 60000)
  it('keeps a supervised core running when a process outside the supervisor sends it SIGTERM', async () => {
    const running = await fixture()
    const stream = await attach(running.url)
    const pid = stream.system().process.pid
    process.kill(pid, 'SIGTERM')
    await until(() => running.output().includes(`Ignored SIGTERM sent to core pid ${pid}`))
    expect(running.output()).not.toContain('exited unexpectedly')
    expect((await fetch(running.url + '/api/models')).status).toBe(200)
    expect(() => process.kill(pid, 0)).not.toThrow()
  }, 60000)
  it('terminates an orphaned storage owner before booting a new supervisor', async () => {
    const running = await fixture()
    const stream = await attach(running.url)
    const pid = stream.system().process.pid
    await stream.close()
    const exited = once(running.child, 'exit')
    running.child.kill('SIGKILL')
    await exited
    const next = await launch(running.home)
    await until(() => next.output().includes('Ultimate: http://'))
    const owner = JSON.parse(await readFile(join(running.home, 'storage.lock'), 'utf8'))
    expect(owner.pid).not.toBe(pid)
    expect(() => process.kill(pid, 0)).toThrow('ESRCH')
    const url = /Ultimate: (http:\/\/[^\s]+)/.exec(next.output())![1]
    expect((await fetch(url + '/api/models')).status).toBe(200)
  }, 60000)
  it('terminates a live detached core when taking over a stale supervisor lock', async () => {
    const home = await temp('ultimate-orphan-')
    homes.push(home)
    const ultimateRoot = await sourceCopy(home)
    copies.set(home, ultimateRoot)
    const core = spawn(process.execPath, [join(ultimateRoot, 'server/main.ts')], {
      cwd: ultimateRoot,
      env: cleanEnv({
        HOME: home,
        ULTIMATE_PROJECT: ultimateRoot,
        ULTIMATE_HOME: home,
        ULTIMATE_PORT: '0',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(core)
    let output = ''
    core.stdout.on('data', (chunk) => {
      output += chunk
    })
    await until(() => output.includes('Ultimate: http://'))
    const original = JSON.parse(await readFile(join(home, 'storage.lock'), 'utf8'))
    expect(original).toEqual({ pid: core.pid, coreStart: expect.any(String) })
    expect(original.coreStart).not.toBe('')
    await writeFile(join(home, 'ultimate.lock'), JSON.stringify({ pid: 2147483647, port: 4747 }))
    const exited = once(core, 'exit')
    const supervisor = await launch(home)
    await until(() => supervisor.output().includes('Ultimate: http://'))
    await exited
    expect(core.signalCode).toBe('SIGKILL')
    const owner = JSON.parse(await readFile(join(home, 'storage.lock'), 'utf8'))
    expect(owner.pid).not.toBe(core.pid)
  }, 60000)
  it('takes over a dead lock and recovers despite a test type error', async () => {
    const home = await temp('ultimate-supervisor-')
    homes.push(home)
    await writeFile(join(home, 'ultimate.lock'), JSON.stringify({ pid: 2147483647, port: 4747 }))
    const running = await launch(home)
    await until(() => running.output().includes('Ultimate: http://'))
    const url = /Ultimate: (http:\/\/[^\s]+)/.exec(running.output())![1]
    const stream = await attach(url)
    const file = join(running.ultimateRoot, 'test/ultimate-recovery-test.ts')
    const extensionFile = join(running.ultimateRoot, 'extensions/ultimate-swap-test.ts')
    try {
      await writeFile(file, 'export const invalid: string = 7\n')
      await writeFile(extensionFile, 'export const invalid: string = 7\n')
      process.kill(stream.system().process.pid, 'SIGKILL')
      await until(() => stream.system().process.generation === 2)
      expect((await fetch(url + '/api/models')).status).toBe(200)
      expect((await post(url, '/api/restart')).status).toBe(202)
      await until(() => stream.system().process.generation === 3)
    } finally {
      await rm(file, { force: true })
      await rm(extensionFile, { force: true })
    }
  }, 60000)
})
