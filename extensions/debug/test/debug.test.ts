import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { context } from '../../../server/harness.ts'
import { age } from '../server.ts'
import { apiSummary } from '../../../lib/api-files.ts'
import { fauxServer, linkDependencies, removeTemp, temp, until } from '../../../test/helpers.ts'

const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
const homes: string[] = []
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  for (const home of homes.splice(0)) await removeTemp(home)
})

const tokens = `
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { defineExtension } from '@earendil-works/pi-durable'
import { defineApi } from '${resolve('shared/extension-api.ts')}'
import { defineEvent } from '${resolve('shared/events.ts')}'
const Beta = defineApi()('beta')
const Missing = defineApi()('absent')
const Pinged = defineEvent('beta.pinged')`
// alpha's action calls beta's service, which emits; gamma's reactor fails on every event.
const extensions = {
  alpha: `${tokens}
export default (host) => {
  host.need(Missing)
  return defineExtension({ name: 'alpha' })
}
export const actions = { go: async (args, { host }) => host.need(Beta).ping(args) }`,
  beta: `${tokens}
export default (host) => {
  host.implement(Beta, {
    async ping(args) {
      await host.harness().commit((tx) => host.emit(tx, Pinged, { n: args.n }), BACKGROUND_CONTEXT)
      return 'pong'
    },
  })
  return defineExtension({ name: 'beta' })
}`,
  gamma: `${tokens}
export default (host) => {
  host.react('on-pinged', [Pinged], async () => { throw new Error('gamma is broken') })
  return defineExtension({ name: 'gamma' })
}`,
}

async function start() {
  const root = await temp('ultimate-debug-')
  homes.push(root)
  await linkDependencies(root)
  await mkdir(join(root, 'web'))
  await writeFile(
    join(root, 'vite.config.ts'),
    "export default { root: 'web', optimizeDeps: { noDiscovery: true } }",
  )
  await mkdir(join(root, 'extensions'))
  await symlink(resolve('extensions/debug'), join(root, 'extensions/debug'))
  for (const [name, source] of Object.entries(extensions)) {
    await mkdir(join(root, 'extensions', name))
    await writeFile(join(root, 'extensions', name, 'server.ts'), source)
  }
  await writeFile(
    join(root, 'extensions/beta/api.ts'),
    '/**\n * Beta: answers pings and says so with an event. Use it to test.\n */\nexport type Beta = { ping(): string }\n',
  )
  const server = await fauxServer({ ultimateRoot: root, home: join(root, 'home'), userHome: root })
  servers.push(server)
  for (const name of ['debug', ...Object.keys(extensions)])
    expect(server.extensions.info().find((entry) => entry.name === name)?.server?.error).toBe(
      undefined,
    )
  const tool = server.host.registry.snapshot().extension('debug')!.tools![0]
  const debug = async (args: Record<string, unknown>) => {
    const result = await tool.execute(args, {} as never, context)
    return (result.output![0] as { text: string }).text
  }
  return { server, debug }
}
const signal = new AbortController().signal

it('shows events, reactor failures, the catalogue and a trace tree, within limits', async () => {
  const { server, debug } = await start()
  for (const n of [1, 2, 3])
    expect(await server.extensions.invoke('alpha', 'go', { n }, signal, 1)).toBe('pong')

  // Newest first, with data and the trace the event was emitted in; limit and filters honoured.
  const events = (await debug({ call: 'events', events: ['beta.pinged'] })).split('\n')
  expect(events).toHaveLength(3)
  expect(events.map((line) => line.match(/\{"n":(\d)\}/)?.[1])).toEqual(['3', '2', '1'])
  expect(events[0]).toMatch(/^\d+s\s+#\d+ {2}beta\.pinged {2}\{"n":3\} {2}trace=\S+ conversation=1/)
  const limited = (await debug({ call: 'events', events: ['beta.pinged'], limit: 2 })).split('\n')
  expect(limited).toEqual(events.slice(0, 2))
  const oldest = Number(/#(\d+)/.exec(events[2])![1])
  expect((await debug({ call: 'events', since: oldest })).split('\n')).toHaveLength(2)
  expect(await debug({ call: 'events', events: ['nothing.here'] })).toBe('No events.')
  await expect(debug({ call: 'events', since: 'yesterday' })).rejects.toThrow('event id')

  // The failing reactor keeps every event pending and reports its error.
  await until(async () => /lag=3/.test(await debug({ call: 'reactors' })))
  await until(async () => (await debug({ call: 'reactors' })).includes('gamma is broken'))
  const reactors = await debug({ call: 'reactors' })
  expect(reactors).toMatch(
    /^gamma\/on-pinged {2}on beta\.pinged {2}cursor=\d+ {2}lag=3 {2}running {2}failed \d+s ago at #\d+: Error: gamma is broken$/m,
  )

  const catalogue = (await debug({ call: 'catalogue' })).split('\n')
  expect(catalogue).toContain('beta  provider=beta  needs: alpha')
  expect(catalogue).toContain('absent  provider=MISSING  needs: alpha')
  expect(catalogue.slice(-2)).toEqual(['missing: absent', 'cycles: none'])

  // Rows newest first, limited; a trace id gives the whole chain, indented under its parents.
  const rows = (await debug({ call: 'trace', conversation: 1, limit: 2 })).split('\n')
  expect(rows).toHaveLength(2)
  for (const row of rows)
    expect(row).toMatch(/^\d+s\s+\w+ {2}\S+ → \S+ {2}\d+ms .* trace=\S+ conversation=1$/)
  const first = server.extensions.trace.query().find((row) => row.name === 'alpha/go')!
  // Each later event's commit retries the first event, whose reactor runs join the first trace.
  await until(() => server.extensions.trace.query({ trace: first.trace }).length >= 5)
  const tree = (await debug({ call: 'trace', trace: first.trace })).split('\n')
  expect(tree.slice(0, 3)).toEqual([
    expect.stringMatching(/^action {2}ui → alpha\/go {2}\d+ms {2}ok {2}args=\{"n":1\}$/),
    expect.stringMatching(/^ {2}service {2}alpha → beta\.ping {2}\d+ms {2}ok {2}args=/),
    expect.stringMatching(
      /^ {4}reactor {2}beta\.pinged → gamma\/on-pinged {2}\d+ms {2}failed: gamma is broken/,
    ),
  ])
  // A limit cuts the tree and says how much is left.
  expect(await debug({ call: 'trace', trace: first.trace, limit: 2 })).toBe(
    [...tree.slice(0, 2), `… ${tree.length - 2} more; narrow the query or raise limit`].join('\n'),
  )
  expect(await debug({ call: 'trace', trace: 'unknown' })).toBe('No calls.')
})

it('lists extension contracts with summaries and returns one by name', async () => {
  const { debug } = await start()
  expect(await debug({ call: 'apis' })).toBe('beta  Beta: answers pings and says so with an event.')
  const beta = await debug({ call: 'api', name: 'beta' })
  expect(beta.startsWith('// beta/api.ts: the server contract')).toBe(true)
  expect(beta).toContain('export type Beta')
  await expect(debug({ call: 'api', name: 'alpha' })).rejects.toThrow(
    'No enabled extension "alpha" with an api.ts or refs.ts; known: beta',
  )
})

it('summarises an api.ts by the first sentence of its opening doc comment, as the lint rule requires', () => {
  expect(apiSummary('/**\n * Beta: pings,\n * across lines. More.\n */\nexport {}')).toBe(
    'Beta: pings, across lines.',
  )
  expect(apiSummary('/** No sentence end */')).toBe('')
  expect(apiSummary('export {}\n/** Too late. */')).toBe('')
  expect(apiSummary('// Not a doc comment.\nexport {}')).toBe('')
})

it('says ages in the largest whole unit', () => {
  const now = Date.parse('2026-01-02T00:00:00Z')
  const ago = (seconds: number) => age(new Date(now - seconds * 1000).toISOString(), now)
  expect([ago(5), ago(125), ago(3 * 3600 + 5), ago(2 * 86400 + 10)]).toEqual([
    '5s',
    '2m',
    '3h',
    '2d',
  ])
})
