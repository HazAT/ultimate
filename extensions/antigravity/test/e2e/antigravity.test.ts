import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { fauxServer, temp, until } from '../../../../test/helpers.ts'

it('keeps its provider across a reload, persists no relay address, and leaves on disable', async () => {
  const home = await temp()
  const agy = join(home, 'agy')
  await writeFile(
    agy,
    `#!${process.execPath}
if (process.argv[2] === 'models') {
  console.log('Fetching available models...')
  console.log('gemini-x\\tGemini X')
}
`,
  )
  await chmod(agy, 0o755)
  vi.stubEnv('PI_ANTIGRAVITY_COMMAND', agy)
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  const settings = join(projectRoot, '.ultimate/settings.json')
  await writeFile(settings, '{}')
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    home: join(home, 'state'),
    userHome: home,
  })
  const runtime = server.host.modelRuntime
  const status = () =>
    server.extensions.invoke('antigravity', 'status', null, new AbortController().signal)
  try {
    expect(await status()).toEqual({ available: true, loggedIn: true, models: ['Gemini X'] })
    const model = runtime.getModel('antigravity', 'gemini-x')!
    expect(model.name).toBe('Gemini X (Antigravity)')
    expect(model.baseUrl).not.toMatch(/127\.0\.0\.1/)
    const relay = (await runtime.getAuth(model))?.auth.baseUrl
    expect(relay).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/pi$/)

    const before = runtime.getProvider('antigravity')
    const file = join(server.host.ultimateRoot, 'extensions/antigravity/server.ts')
    await writeFile(file, (await readFile(file, 'utf8')) + '\n')
    server.vite.watcher.emit('change', file)
    await until(() => runtime.getProvider('antigravity') !== before)
    await until(() => !!runtime.getProvider('antigravity'))
    expect(await status()).toMatchObject({ loggedIn: true })
    const reloaded = (await runtime.getAuth(model))?.auth.baseUrl
    expect(reloaded).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/pi$/)
    expect(reloaded).not.toBe(relay)
    expect(
      (await fetch(`${reloaded}/models/gemini-x:streamGenerateContent`, { method: 'POST' })).status,
    ).toBe(401)
    await until(() =>
      fetch(`${relay}/models/gemini-x:streamGenerateContent`, { method: 'POST' }).then(
        () => false,
        () => true,
      ),
    )

    await writeFile(settings, JSON.stringify({ extensions: { disable: ['antigravity'] } }))
    await until(() => !runtime.getProvider('antigravity'))
    expect(runtime.getAllModels().some((one) => one.provider === 'antigravity')).toBe(false)
    const after = (await runtime.getAuth(model))?.auth.baseUrl
    expect(after).toBeUndefined()
    await expect(
      fetch(`${reloaded}/models/gemini-x:streamGenerateContent`, { method: 'POST' }),
    ).rejects.toThrow('fetch failed')
  } finally {
    await server.close()
  }
})
