import { chmod, mkdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fauxServer, removeTemp, temp, until } from '../../../../test/helpers.ts'
import { readSecret, secretMetadata, validateValue } from '../../../../lib/secrets.ts'
import { writeSecret } from '../../store.ts'

const homes: string[] = []
const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const directory of homes.splice(0)) await removeTemp(directory)
})
async function home() {
  const value = await temp()
  homes.push(value)
  return value
}
it('stores atomically under concurrent sets with private modes, refuses unsafe files, and deletes', async () => {
  const root = await home()
  await Promise.all(
    Array.from({ length: 12 }, (_, i) => writeSecret(root, `KEY_${i}`, `value-${i}`)),
  )
  expect((await stat(join(root, '.ultimate'))).mode & 0o777).toBe(0o700)
  expect((await stat(join(root, '.ultimate/secrets.json'))).mode & 0o777).toBe(0o600)
  expect(await secretMetadata(root)).toHaveLength(12)
  expect(await readSecret(root, 'KEY_1')).toBe('value-1')
  await writeSecret(root, 'KEY_1')
  expect(await readSecret(root, 'KEY_1')).toBeUndefined()
  await chmod(join(root, '.ultimate/secrets.json'), 0o644)
  await expect(readSecret(root, 'KEY_0')).rejects.toThrow('chmod 600')
  await expect(writeSecret(root, 'KEY_0', 'new')).rejects.toThrow('chmod 600')
})
it('validates values without echoing them', () => {
  for (const value of ['', 'x\n', 'x\r', 'x\0', 'ü'.repeat(8193)])
    expect(() => validateValue(value)).toThrow('Secret value')
  expect(() => validateValue('ü'.repeat(8192))).not.toThrow()
})
it('surfaces valid declarations, metadata including declaredBy, and never leaks a sentinel in actions or system info; rejects invalid facets', async () => {
  const root = await home()
  await mkdir(join(root, '.ultimate'), { recursive: true })
  await writeFile(
    join(root, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['secrets', 'parallel'] } }),
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: root,
    userHome: root,
    home: join(root, 'state'),
  })
  servers.push(server)
  expect(
    server.extensions.info().find((entry) => entry.name === 'parallel')?.server?.secrets,
  ).toEqual([
    {
      name: 'PARALLEL_API_KEY',
      description: 'parallel.ai API key for web search and fetch',
      url: 'https://platform.parallel.ai',
    },
  ])
  const sentinel = 'ULT102-SENTINEL-DO-NOT-LEAK'
  const invoke = (action: string, args: Parameters<typeof server.extensions.invoke>[2]) =>
    server.extensions.invoke('secrets', action, args, new AbortController().signal)
  const results = [
    await invoke('list', null),
    await invoke('set', { name: 'PARALLEL_API_KEY', value: sentinel }),
    await invoke('set', { name: 'OTHER_KEY', value: sentinel }),
    await invoke('list', null),
  ]
  expect(results[3]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'PARALLEL_API_KEY', declaredBy: ['parallel'], set: true }),
      expect.objectContaining({ name: 'OTHER_KEY', declaredBy: [], set: true }),
    ]),
  )
  expect(JSON.stringify([results, server.system.current()])).not.toContain(sentinel)
  results.push(await invoke('delete', { name: 'OTHER_KEY' }), await invoke('list', null))
  expect(JSON.stringify([results, server.system.current()])).not.toContain(sentinel)
  expect(await readSecret(root, 'OTHER_KEY')).toBeUndefined()
  const folder = join(root, '.ultimate/extensions/invalid-secret')
  await mkdir(folder, { recursive: true })
  for (const declaration of [
    { name: 'bad', description: 'x' },
    { name: 'GOOD', description: '' },
    { name: 'GOOD', description: 'x', url: 'file:///tmp/x' },
  ]) {
    await writeFile(
      join(folder, 'server.ts'),
      `import { defineExtension } from '@earendil-works/pi-durable'; export const secrets = ${JSON.stringify([declaration])}; export default defineExtension({name:'invalid-secret'})`,
    )
    await until(
      () =>
        !!server.extensions.info().find((entry) => entry.name === 'invalid-secret')?.server?.error,
    )
    expect(
      server.extensions.info().find((entry) => entry.name === 'invalid-secret')?.server?.error,
    ).toMatch(/secret/)
    await new Promise((done) => setTimeout(done, 100))
  }
})
