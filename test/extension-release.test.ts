import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { context } from '../server/harness.ts'
import type { ReactorStatus } from '../server/events.ts'
import { prepareFauxServer, temp, until } from './helpers.ts'

it('a reactor registered inside a resource stays stopped once its facet is disabled, across a release and reacquire', async () => {
  const home = await temp('ultimate-extension-release-')
  const projectRoot = join(home, 'project')
  const folder = join(projectRoot, '.ultimate/extensions/resource-reactor')
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'server.ts'),
    `import { defineExtension } from '@earendil-works/pi-durable'
import { StartedEvent } from ${JSON.stringify(resolve('shared/events.ts'))}
export default (host) => {
  globalThis.resourceReactorProbe?.(() => host.eventLog.reactors())
  host.resource('resource-reactor', () => host.react('started', [StartedEvent], async () => {}))
  return defineExtension({ name: 'resource-reactor' })
}`,
  )
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ summaryModel: 'unavailable/test' }),
  )
  let reactors!: () => Promise<ReactorStatus[]>
  Object.assign(globalThis, {
    resourceReactorProbe: (read: typeof reactors) => (reactors = read),
  })
  const prepared = await prepareFauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  try {
    await prepared.go()
    const running = async () =>
      (await reactors()).find((reactor) => reactor.name === 'resource-reactor/started')?.running
    expect(await running()).toBe(true)
    await writeFile(
      join(projectRoot, '.ultimate/settings.json'),
      JSON.stringify({ extensions: { disable: ['resource-reactor'] } }),
    )
    await until(
      () =>
        prepared.extensions.info().find((e) => e.name === 'resource-reactor')?.enabled === false,
    )
    expect(await running()).toBe(false)
    await prepared.release()
    await prepared.go()
    expect(await running()).toBe(false)
  } finally {
    Reflect.deleteProperty(globalThis, 'resourceReactorProbe')
    await prepared.close()
  }
})

it('a core swap release ends every extension commit observer, and a reacquire attaches them once', async () => {
  const home = await temp('ultimate-extension-release-')
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ summaryModel: 'unavailable/test' }),
  )
  const prepared = await prepareFauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  const notices: string[] = []
  prepared.events.listeners.add((name, data) => {
    if (name === 'notice') notices.push((data as { message: string }).message)
  })
  const observersFromExtensions = new Set<object>()
  const open = prepared.host.open.bind(prepared.host)
  prepared.host.open = async (...args) => {
    const opened = await open(...args)
    const observe = opened.harness.observeCommits.bind(opened.harness)
    opened.harness.observeCommits = (observer) => {
      const key = {}
      if (new Error().stack!.includes('/extensions/')) observersFromExtensions.add(key)
      const observation = observe({
        ...observer,
        end: (end) => {
          observersFromExtensions.delete(key)
          observer.end(end)
        },
      })
      return {
        detach: () => {
          observersFromExtensions.delete(key)
          observation.detach()
        },
      }
    }
    return opened
  }
  try {
    const first = await prepared.go()
    const attachedOnOpen = observersFromExtensions.size
    expect(attachedOnOpen).toBeGreaterThan(0)
    for (let i = 0; i < 20; i++)
      await first.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
    await prepared.extensions.released()
    expect(observersFromExtensions.size).toBe(0)
    await prepared.release()
    await prepared.go()
    expect(observersFromExtensions.size).toBe(attachedOnOpen)
    expect(notices.filter((message) => message.includes('Harness is not open'))).toEqual([])
  } finally {
    await prepared.close()
  }
})
