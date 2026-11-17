import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { until } from './helpers.ts'
import { fixture, servers } from './server-fixture.ts'

const gated = (name: string) => `
import { defineExtension } from '@earendil-works/pi-durable'
export const reloadOnSettings = true
export default async (host) => {
  const gate = globalThis.__closeGate
  if (gate) {
    gate.started.push('${name}')
    gate.hosts.set('${name}', host)
    await gate.open
    gate.log.push('${name} built')
    host.onClose(async () => { gate.log.push('${name} closed') })
  }
  return defineExtension({ name: '${name}' })
}`

it('close during a reload finishes the loading facet and skips queued and remaining loads', async () => {
  const { server, options } = await fixture(false, {
    'a-first': gated('a-first'),
    'b-second': gated('b-second'),
  })
  const gate = {
    started: [] as string[],
    log: [] as string[],
    hosts: new Map<string, { reloadExtensions: () => Promise<void> }>(),
    open: undefined as unknown as Promise<void>,
    release: () => {},
  }
  gate.open = new Promise<void>((resolve) => (gate.release = resolve))
  Object.assign(globalThis, { __closeGate: gate })
  try {
    const settings = join(options.projectRoot, '.ultimate/settings.json')
    const value = JSON.parse(await readFile(settings, 'utf8'))
    await writeFile(settings, JSON.stringify({ ...value, touched: true }))
    server.vite.watcher.emit('change', settings)
    await until(() => gate.started.includes('a-first'))
    // A reload that starts tells Vite's resolver that node_modules changed first, so this counts reloads that began.
    // Vite's own change handler also calls watchChange, with the changed file.
    const prepared = vi.fn<(file: string) => Promise<void>>(async () => {})
    for (const environment of Object.values(server.vite.environments))
      vi.spyOn(environment.pluginContainer, 'watchChange').mockImplementation(prepared)
    const queuedBefore = gate.hosts.get('a-first')!.reloadExtensions()
    // The running reload is gated, so a second watcher event queues behind it.
    server.vite.watcher.emit('change', settings)
    let queuedAfter: Promise<void> | undefined
    // The extensions stop watching right after they mark themselves closed.
    const off = server.vite.watcher.off.bind(server.vite.watcher)
    vi.spyOn(server.vite.watcher, 'off').mockImplementation((event, listener) => {
      if (event === 'add') {
        queuedAfter = gate.hosts.get('a-first')!.reloadExtensions()
        gate.release()
      }
      return off(event, listener)
    })
    servers.splice(servers.indexOf(server), 1)
    await server.close()
    await Promise.all([queuedBefore, queuedAfter])
    expect(gate.started).toEqual(['a-first'])
    expect(prepared.mock.calls.filter(([file]) => file.endsWith('/node_modules'))).toEqual([])
    expect(gate.log).toEqual(['a-first built', 'a-first closed'])
  } finally {
    Reflect.deleteProperty(globalThis, '__closeGate')
  }
})
