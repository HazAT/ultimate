import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { AgentDoc } from '@earendil-works/pi-durable'
import { execFileSync } from 'node:child_process'
import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.shared.ts'
import { SOURCE_HEADER } from '../../../../shared/protocol.ts'
import { fauxServer, post, temp, until } from '../../../../test/helpers.ts'
import { Session } from '../../updates.ts'

it('streams the fake ACP agent, binds approval to the request, and saves output before shutdown or conclusion', async () => {
  vi.stubEnv('ULTIMATE_AGY_COMMAND', fileURLToPath(new URL('../fake-agy.mjs', import.meta.url)))
  const home = await temp()
  const projectRoot = join(home, 'project')
  const settings = join(projectRoot, '.ultimate/settings.json')
  await mkdir(dirname(settings), { recursive: true })
  await writeFile(settings, JSON.stringify({ extensions: { enable: ['acp'] } }))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: projectRoot })
  git('init', '-q', '-b', 'main')
  git(
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'initial',
  )
  const open = () =>
    fauxServer({
      ultimateRoot: resolve('.'),
      projectRoot,
      home: join(home, 'state'),
      userHome: home,
    })
  let server = await open()
  const action = (name: string, args: unknown, conversationId?: number) =>
    post(server, `/api/extensions/acp/actions/${name}`, { args, conversationId })
  try {
    const started = await action('start', { isolated: true })
    expect(started.status).toBe(200)
    const id = parseConversationId(started.data.result.id)
    const session = () => server.harness.snapshot(Session, id, context)
    const entries = async () =>
      (await server.harness.commit((tx) => tx.scanEntries({ conversationId: id }, 20), context))
        .items
    await until(async () => (await session())?.status === 'idle')
    const workspace = join(home, 'state', 'worktrees', String(id))
    expect(await server.harness.snapshot(AgentDoc, id, context)).toMatchObject({
      tools: [],
      cwd: workspace,
    })
    expect((await server.harness.snapshot(AgentDoc, id, context))?.model).toBeUndefined()
    const conversation = (await server.harness.conversation(id, context))!
    await expect(
      conversation.submit({ type: 'input', content: 'Not a typed ACP prompt' }, context),
    ).rejects.toThrow('Antigravity takes only your own input')

    expect((await action('config', { option: 'model', value: 'gemini-flash' }, id)).status).toBe(
      200,
    )
    expect((await action('prompt', { text: 'Inspect the file' }, id)).status).toBe(200)
    await until(async () => !!(await session())?.permission)
    const ask = (await session())!.permission!
    expect(ask.options.map((option) => option.name)).toEqual(['Allow once', 'Reject'])
    const stale = await action('permit', { request: 'previous-request', option: 'allow' }, id)
    expect(stale.status).toBe(500)
    expect(stale.data.error).toBe('That permission request is no longer pending')
    expect((await session())?.permission).toEqual(ask)
    expect((await entries()).some((entry) => entry.kind === 'pi.tool-result')).toBe(false)
    expect((await action('permit', { request: ask.id, option: 'allow' }, id)).status).toBe(200)
    await until(async () => (await session())?.status === 'idle')
    const stored = await entries()
    expect(stored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'pi.assistant',
          model: [
            expect.objectContaining({
              model: 'Gemini Flash',
              content: [{ type: 'text', text: 'Read with gemini-flash.' }],
            }),
          ],
        }),
        expect.objectContaining({
          kind: 'pi.tool-result',
          model: [expect.objectContaining({ toolName: 'read' })],
        }),
      ]),
    )

    expect((await action('prompt', { text: 'Inspect the file' }, id)).status).toBe(200)
    await until(async () => !!(await session())?.permission)
    expect((await session())?.permission?.id).not.toBe(ask.id)
    await server.close()
    server = await open()
    await until(async () => (await session())?.status === 'offline')
    expect(JSON.stringify(await entries())).toContain('Final output before exit.')
    expect((await action('prompt', { text: 'Continue' }, id)).status).toBe(200)
    await until(async () => (await session())?.status === 'idle')
    expect(JSON.stringify(await entries())).toContain('Fake ACP: Continue')
    expect(JSON.stringify(await entries())).not.toContain('Do not replay this')

    expect((await action('prompt', { text: 'Inspect the file' }, id)).status).toBe(200)
    await until(async () => !!(await session())?.permission)
    const concluded = await post(server, '/api/extensions/conversations/actions/conclude', {
      args: { ids: [id] },
    })
    expect(concluded.status).toBe(200)
    expect(await session()).toMatchObject({ status: 'offline' })
    expect((await session())?.permission).toBeUndefined()
    expect(JSON.stringify(await entries()).match(/Final output before exit\./g)).toHaveLength(2)
    await expect(lstat(workspace)).rejects.toMatchObject({ code: 'ENOENT' })

    const resumed = await post(server, '/api/extensions/conversations/actions/resume', {
      args: { ids: [id] },
    })
    expect(resumed).toMatchObject({ status: 200, data: { result: { resumed: [id] } } })
    expect((await action('prompt', { text: 'Continue after conclusion' }, id)).status).toBe(200)
    await until(async () => (await session())?.status === 'idle')
    expect((await lstat(workspace)).isDirectory()).toBe(true)
    expect(JSON.stringify(await entries())).toContain('Fake ACP: Continue after conclusion')
  } finally {
    await server.close()
  }
})

it('refuses the browser agent source and the in-process agent action', async () => {
  const home = await temp()
  const userHome = join(home, 'user')
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['acp'] } }),
  )
  const server = await fauxServer({ ultimateRoot: resolve('.'), home, userHome })
  try {
    for (const name of ['start', 'prompt', 'cancel', 'permit', 'config']) {
      const response = await fetch(`${server.url}/api/extensions/acp/actions/${name}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: server.url,
          [SOURCE_HEADER]: 'agent',
        },
        body: JSON.stringify({ args: null }),
      })
      expect(response.status).toBe(500)
      expect(await response.json()).toMatchObject({
        error: 'Antigravity takes only your own input',
      })
      await expect(
        server.extensions.invoke(
          'acp',
          name,
          null,
          new AbortController().signal,
          undefined,
          'agent',
        ),
      ).rejects.toThrow('is a user-only action')
    }
  } finally {
    await server.close()
  }
})
