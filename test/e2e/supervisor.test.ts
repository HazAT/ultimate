import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanEnv, until, post } from '../helpers.ts'
import { children, fixture, attach, activationFailure, transcript } from './supervisor-helpers.ts'
describe('supervisor restart', () => {
  it('replays a memoed restart in generation 2 and reconnects SSE to the finished transcript', async () => {
    const running = await fixture()
    const stream = await attach(running.url)
    const oldBuild = stream.system().build
    expect(
      (await post(running.url, '/api/conversations/1/submit', { text: 'restart yourself' })).status,
    ).toBe(202)
    await until(
      () =>
        stream.system().process.generation === 2 &&
        transcript(stream.view()).includes('Restarted. Now running generation 2'),
    )
    await until(
      () => stream.view().entries.filter((entry) => entry.kind === 'pi.assistant').length === 2,
    )
    expect(stream.connections()).toBeGreaterThan(1)
    expect(stream.system().build.id).toBe(oldBuild.id)
    expect(stream.system().build.changed).toEqual([])
    expect(
      stream.view().entries.findLast((entry) => entry.kind === 'pi.tool-result')?.model?.[0],
    ).toMatchObject({
      details: {
        fromGeneration: 1,
        toGeneration: 2,
        fromBuild: oldBuild.id,
        toBuild: stream.system().build.id,
      },
    })
    expect(stream.system().build.generation).toBe(2)
    expect(transcript(stream.view())).toContain(
      `build ${oldBuild.id} → ${stream.system().build.id}`,
    )
    expect(transcript(stream.view())).toContain(`(pid ${stream.system().process.pid})`)
    expect(
      JSON.stringify(stream.view().entries.filter((entry) => entry.kind === 'pi.tool-result')),
    ).not.toContain('interrupted')
  }, 60000)
  it('keeps generation 1 serving and returns a failed preparation to the tool', async () => {
    const running = await fixture()
    await writeFile(
      join(running.ultimateRoot, 'server/invalid.ts'),
      'export const invalid: string = 7\n',
    )
    const stream = await attach(running.url)
    await post(running.url, '/api/conversations/1/submit', { text: 'restart yourself' })
    await until(
      () =>
        transcript(stream.view()).includes('not assignable to type') &&
        stream.view().entries.filter((entry) => entry.kind === 'pi.assistant').length === 2,
    )
    expect(stream.system().process.generation).toBe(1)
    expect(stream.connections()).toBe(1)
    expect(transcript(stream.view())).toContain('"isError":true')
    expect((await fetch(running.url + '/api/models')).status).toBe(200)
  }, 60000)
  it('rolls back failed activation and reports it from the replayed restart tool', async () => {
    const running = await fixture()
    const stream = await attach(running.url)
    const pid = stream.system().process.pid
    await activationFailure(running.ultimateRoot)
    await post(running.url, '/api/conversations/1/submit', { text: 'restart yourself' })
    await until(() =>
      transcript(stream.view()).includes(
        'Restart failed during activation; rolled back to generation 1',
      ),
    )
    expect(transcript(stream.view())).toContain('Injected activation failure')
    expect(transcript(stream.view())).toContain('"isError":true')
    expect(
      stream.view().entries.findLast((entry) => entry.kind === 'pi.tool-result')?.model?.[0],
    ).toMatchObject({
      details: {
        fromGeneration: 1,
        toGeneration: 1,
        rolledBack: true,
        error: expect.stringContaining('Injected activation failure'),
      },
    })
    expect(stream.system().process.pid).toBe(pid)
    expect(stream.system().process.activationError).toContain('Injected activation failure')
    expect(stream.system().process.generation).toBe(1)
    expect((await fetch(running.url + '/api/models')).status).toBe(200)
    const owner = JSON.parse(await readFile(join(running.home, 'storage.lock'), 'utf8'))
    expect(owner.pid).toBe(pid)
  }, 60000)
  it('settles the original API restart request on rollback and keeps standalone off storage', async () => {
    const running = await fixture(async (root) => {
      const file = join(root, 'server/api.ts')
      const api = await readFile(file, 'utf8')
      await writeFile(
        file,
        api.replace(
          'if (!response.writableEnded) json(500, { ok: false, error })',
          "console.log('Restart request settled:', error); if (!response.writableEnded) json(500, { ok: false, error })",
        ),
      )
    })
    const stream = await attach(running.url)
    const pid = stream.system().process.pid
    await activationFailure(running.ultimateRoot)
    // The API responds to the early swap acknowledgement. Observe the original handler beyond it.
    expect((await post(running.url, '/api/restart')).status).toBe(202)
    await until(() =>
      /Restart request settled: .*Injected activation failure/.test(running.output()),
    )
    await until(() => stream.connections() > 1 && !!stream.system().process.activationError)
    expect(stream.system().process.activationError).toContain('Injected activation failure')
    expect(stream.system().process.generation).toBe(1)
    expect((await fetch(running.url + '/api/models')).status).toBe(200)
    const standalone = spawn(process.execPath, [join(running.ultimateRoot, 'server/main.ts')], {
      cwd: running.ultimateRoot,
      env: cleanEnv({
        HOME: running.home,
        ULTIMATE_PROJECT: running.ultimateRoot,
        ULTIMATE_HOME: running.home,
        ULTIMATE_PORT: '0',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(standalone)
    let output = ''
    standalone.stderr.on('data', (chunk) => {
      output += chunk
    })
    const [code] = await once(standalone, 'exit')
    expect(code).not.toBe(0)
    expect(output).toContain(`Ultimate core already owns this storage (pid ${pid})`)
  }, 60000)
  it('survives SIGKILL mid-turn and resumes the transcript through the same public port', async () => {
    const running = await fixture()
    const stream = await attach(running.url)
    await post(running.url, '/api/conversations/1/submit', { text: 'demo' })
    await until(() => transcript(stream.view()).includes('starting'))
    expect(transcript(stream.view())).not.toContain('## Complete')
    process.kill(stream.system().process.pid, 'SIGKILL')
    await until(
      () =>
        stream.system().process.generation === 2 &&
        transcript(stream.view()).includes('## Complete'),
    )
    expect(stream.connections()).toBeGreaterThan(1)
    expect(await readFile(join(running.ultimateRoot, 'scratch.txt'), 'utf8')).toBe('after\n')
  }, 60000)
  it('accepts an API swap and rejects a type error without releasing the active owner', async () => {
    const running = await fixture()
    const stream = await attach(running.url)
    const file = join(running.ultimateRoot, 'server/ultimate-typecheck-test.ts')
    try {
      await writeFile(file, 'const invalid: string = 7; export { invalid }\n')
      await until(() => stream.system().code.coreStale === true)
      const [failed, concurrent] = (
        await Promise.all([post(running.url, '/api/restart'), post(running.url, '/api/restart')])
      ).toSorted((result) => (String(result.data.error).includes('in progress') ? 1 : -1))
      expect(concurrent).toEqual({
        status: 500,
        data: { ok: false, error: 'A core swap is already in progress.' },
      })
      expect(failed.status).toBe(500)
      expect(failed.data.error).toContain('not assignable to type')
      expect(stream.system().process.generation).toBe(1)
      expect((await fetch(running.url + '/api/models')).status).toBe(200)
    } finally {
      await rm(file, { force: true })
    }
    const swapped = await post(running.url, '/api/restart')
    expect(swapped).toEqual({ status: 202, data: { ok: true, generation: 2 } })
    await until(() => stream.system().process.generation === 2)
    expect(stream.system().code.coreStale).toBe(false)
    expect(stream.connections()).toBeGreaterThan(1)
  }, 60000)
})
