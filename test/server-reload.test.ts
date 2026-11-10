import { request } from 'node:http'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineExtension } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { prepareFauxServer as prepareServer, until, post, attach } from './helpers.ts'
import { context } from '../server/harness.ts'
import type { ServerEvents } from '../shared/protocol.ts'
import { fixture, orderedSource } from './server-fixture.ts'

describe('server reload', () => {
  it('tracks extension and web builds and stores positional prompt changes', async () => {
    const { server, options } = await fixture(true)
    const first = server.host.build()
    const prepared = await prepareServer({ ...options, home: join(options.home, 'second') })
    expect(prepared.host.build().id).toBe(first.id)
    await prepared.close()
    const stream = await attach(server)
    await post(server, '/api/conversations/1/submit', { text: 'before' })
    await server.harness.waitForIdle(context)
    await writeFile(
      join(options.ultimateRoot, 'extensions/counter/value.ts'),
      "export const value = 'new'",
    )
    await until(() => server.host.build().id !== first.id)
    const second = server.host.build()
    expect(second.extensions.counter).not.toBe(first.extensions.counter)
    expect(second.changed).toEqual(['extensions/counter'])
    await until(() =>
      stream.events.some(
        (event) =>
          event.name === 'system' && (event.data as ServerEvents['system']).build.id === second.id,
      ),
    )
    await post(server, '/api/conversations/1/submit', { text: 'after' })
    await server.harness.waitForIdle(context)
    const entries = async () => {
      const view = await server.root.context(context)
      const all = view.entries
      return all
    }
    const afterChange = await entries()
    // The counter's own section changed; the build is never part of the system prompt.
    const systems = afterChange.filter((entry) => entry.kind === 'pi.system')
    expect(systems.length).toBeGreaterThan(1)
    expect(JSON.stringify(systems)).not.toContain(first.id)
    // The first run recorded its build silently; the run after the reload gets one note, right before its input.
    const notes = afterChange.filter((entry) => entry.kind === 'prompt.build')
    expect(notes).toHaveLength(1)
    expect(notes[0].model?.[0]?.content).toBe(
      `Build changed: ${first.id} → ${second.id} · generation 1 · changed: extensions/counter`,
    )
    const users = afterChange.filter((entry) => entry.model?.[0]?.role === 'user')
    expect(users.map((entry) => entry.kind).slice(-2)).toEqual(['prompt.build', 'pi.user'])

    // A build that changes no section leaves the system prompt as it was; only the note says so.
    await writeFile(
      join(options.ultimateRoot, 'extensions/web-only/web.tsx'),
      'export default () => "changed"',
    )
    await until(() => server.host.build().id !== second.id)
    const third = server.host.build()
    expect(third.changed).toEqual(['extensions/web-only'])
    await post(server, '/api/conversations/1/submit', { text: 'web only' })
    await server.harness.waitForIdle(context)
    await post(server, '/api/conversations/1/submit', { text: 'unchanged' })
    await server.harness.waitForIdle(context)
    const later = (await entries()).filter((entry) => entry.id > afterChange.at(-1)!.id)
    expect(later.filter((entry) => entry.kind === 'pi.system')).toEqual([])
    // Exactly one note for the change, none for the unchanged build after it.
    expect(later.filter((entry) => entry.kind === 'prompt.build').map((e) => e.data)).toEqual([
      { from: second.id, to: third.id },
    ])
    await stream.close()
  })
  it('rejects foreign Hosts on API and Vite and accepts localhost Origin', async () => {
    const { server } = await fixture()
    for (const path of ['/api/events', '/']) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(
          server.url + path,
          { headers: { Host: `evil.example:${server.port}` } },
          (response) => {
            response.resume()
            resolve(response.statusCode)
          },
        )
        req.on('error', reject)
        req.end()
      })
      expect(status).toBe(403)
    }
    expect(
      (
        await fetch(server.url + '/api/conversations/1/configure', {
          method: 'POST',
          headers: {
            Origin: `http://localhost:${server.port}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        })
      ).status,
    ).toBe(200)
  })
  it('hot reloads a transitive local import and retains the old extension on a syntax error', async () => {
    const { server } = await fixture(true)
    const entry = () => server.extensions.info().find((extension) => extension.name === 'counter')!
    const loaded = entry().server!.loadedAt
    const promptLoaded = server.extensions.info().find((extension) => extension.name === 'prompt')!
      .server!.loadedAt
    await writeFile(
      join(server.host.ultimateRoot, 'extensions/counter/value.ts'),
      "export const value = 'two'",
    )
    await until(() => entry().server!.loadedAt !== loaded)
    const installed = server.host.registry.snapshot().extension('counter')!
    const section = installed.sections![0]
    expect(await section.render({} as Parameters<typeof section.render>[0], context)).toBe('two')
    expect(
      server.extensions.info().find((extension) => extension.name === 'prompt')!.server!.loadedAt,
    ).toBe(promptLoaded)
    const successful = entry().server!.loadedAt
    await writeFile(
      join(server.host.ultimateRoot, 'extensions/counter/value.ts'),
      'this is not valid TS !!!',
    )
    // Chokidar can coalesce consecutive writes to the same path; deliver this change explicitly.
    server.vite.watcher.emit(
      'change',
      join(server.host.ultimateRoot, 'extensions/counter/value.ts'),
    )
    await until(() => !!entry().server!.error)
    expect(entry().server!.loadedAt).toBe(successful)
    expect(server.host.registry.snapshot().extension('counter')).toBe(installed)
  })
  it('reloads only the owning extension when files or directories are added or removed', async () => {
    const { server } = await fixture(false, {
      a: orderedSource('a'),
      b: orderedSource('b'),
    })
    const loadedAt = (name: string) =>
      server.extensions.info().find((extension) => extension.name === name)!.server!.loadedAt
    const bLoaded = loadedAt('b')
    const folder = join(server.host.ultimateRoot, 'extensions/a')
    const file = join(folder, 'new.ts')
    const nested = join(folder, 'nested')
    // Its test/ folder is not part of an extension: with a test in it, the build names the same extension as before.
    const built = server.host.build().extensions.a
    await mkdir(join(folder, 'test'))
    await writeFile(join(folder, 'test/a.test.ts'), 'export const value = 1')
    for (const change of [
      () => writeFile(file, 'export const value = 1'),
      () => rm(file),
      () => mkdir(nested),
      () => rm(nested, { recursive: true }),
    ]) {
      const aLoaded = loadedAt('a')
      await change()
      await until(() => loadedAt('a') !== aLoaded)
      expect(loadedAt('b')).toBe(bLoaded)
    }
    await until(() => server.host.build().extensions.a === built)
  })
  it('keeps hot reloading extensions after a Vite config change restarts Vite', async () => {
    const { server } = await fixture(true)
    const entry = () => server.extensions.info().find((extension) => extension.name === 'counter')!
    const config = join(server.host.ultimateRoot, 'vite.config.ts')
    const watcher = server.vite.watcher
    await writeFile(config, `${await readFile(config, 'utf8')}\n`)
    await until(() => server.vite.watcher !== watcher)
    // Replacing the watcher does not wait for its initial extension-directory scan.
    await until(() => {
      const watched = server.vite.watcher.getWatched()
      return watched[join(server.host.ultimateRoot, 'extensions/counter')]?.includes('value.ts')
    })
    const loaded = entry().server!.loadedAt
    await writeFile(
      join(server.host.ultimateRoot, 'extensions/counter/value.ts'),
      "export const value = 'after restart'",
    )
    await until(() => entry().server!.loadedAt !== loaded)
    const section = server.host.registry.snapshot().extension('counter')!.sections![0]
    expect(await section.render({} as Parameters<typeof section.render>[0], context)).toBe(
      'after restart',
    )
  })
  it('does not uninstall an extension installed outside the folder loader', async () => {
    const { server } = await fixture(true)
    const external = defineExtension({ name: 'web-only' })
    server.host.registry.install(external)
    await writeFile(
      join(server.host.ultimateRoot, 'extensions/web-only/README.md'),
      'Changed browser facet',
    )
    await until(
      () =>
        server.extensions.info().find((extension) => extension.name === 'web-only')?.readme ===
        'Changed browser facet',
    )
    expect(server.host.registry.snapshot().extension('web-only')).toBe(external)
    await rm(join(server.host.ultimateRoot, 'extensions/web-only'), {
      recursive: true,
      force: true,
      maxRetries: 5,
    })
    await until(() => !server.extensions.info().some((extension) => extension.name === 'web-only'))
    expect(server.host.registry.snapshot().extension('web-only')).toBe(external)
    const folder = join(server.host.ultimateRoot, 'extensions', 'added')
    await mkdir(folder)
    await writeFile(
      join(folder, 'server.ts'),
      "import { defineExtension } from '@earendil-works/pi-durable'; export default defineExtension({ name: 'added' })",
    )
    await until(
      () =>
        !!server.extensions.info().find((extension) => extension.name === 'added')?.server
          ?.loadedAt,
    )
    expect(server.host.registry.snapshot().extension('added')).toBeDefined()
    await rm(folder, { recursive: true })
    await until(() => !server.extensions.info().some((extension) => extension.name === 'added'))
    expect(server.host.registry.snapshot().extension('added')).toBeUndefined()
  })
  // 2026-11-10 (#561727): a landing deleted a linked user extension's folder and a script then removed the link; its
  // ENOENT stayed on every instance of the machine until a settings file changed.
  it('drops a linked extension whose folder was deleted once its dangling link is removed', async () => {
    const { server, options } = await fixture(true)
    const info = (name: string) =>
      server.extensions.info().find((extension) => extension.name === name)
    const entry = () => info('linked')
    const target = join(options.userHome, 'elsewhere/linked')
    const link = join(options.userHome, '.ultimate/extensions/linked')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'server.ts'), orderedSource('linked'))
    await mkdir(join(link, '..'), { recursive: true })
    await symlink(target, link)
    await until(() => !!entry()?.server?.loadedAt)
    const gone = new Promise<void>((resolve) => {
      server.vite.watcher.on('unlink', (file) => {
        if (file === join(link, 'server.ts')) resolve()
      })
    })
    await rm(target, { recursive: true })
    await until(() => !!entry()?.server?.error?.includes('ENOENT'))
    // The watcher's last event for the deleted folder, and the reload it queued: reloads run in order, so a later one
    // that finished means no earlier one is left to notice the removed link by accident.
    await gone
    await writeFile(join(server.host.ultimateRoot, 'extensions/web-only/README.md'), 'Settled')
    await until(() => info('web-only')?.readme === 'Settled')
    await rm(link)
    await until(() => !entry())
    expect(server.host.registry.snapshot().extension('linked')).toBeUndefined()
  })
  // Landing c16450c (2026-11-09) changed a patch together with the extension using it: the extension hot-reloaded while
  // pnpm install was still relinking the package and failed with "useExchangeTap is not a function".
  it('loads no extension while an onBeforeLoad callback still waits, such as for an install', async () => {
    const install = { installed: true, waiting: 0, finish: () => {} }
    ;(globalThis as { testInstall?: typeof install }).testInstall = install
    const { server } = await fixture(false, {
      gate: `import { defineExtension } from '@earendil-works/pi-durable'
export default host => {
  const install = globalThis.testInstall
  host.onBeforeLoad(async () => {
    if (install.installed) return
    install.waiting++
    await new Promise(resolve => { install.finish = resolve })
  })
  return defineExtension({ name: 'gate' })
}`,
      user: `import { defineExtension } from '@earendil-works/pi-durable'
if (!globalThis.testInstall.installed) throw new Error('useExchangeTap is not a function')
export default defineExtension({ name: 'user' })`,
    })
    const path = join(server.host.ultimateRoot, 'extensions/user/server.ts')
    const entry = () => server.extensions.info().find((extension) => extension.name === 'user')!
    const loaded = entry().server!.loadedAt
    // The landing: the facet changes while the package it needs is being installed.
    install.installed = false
    await writeFile(path, `${await readFile(path, 'utf8')}\n`)
    await until(() => install.waiting > 0)
    expect(entry().server).toMatchObject({ loadedAt: loaded })
    expect(entry().server!.error).toBeUndefined()
    install.installed = true
    install.finish()
    await until(() => entry().server!.loadedAt !== loaded)
    expect(entry().server!.error).toBeUndefined()
  })
})
