import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { fauxServer, post, temp, removeTemp } from '../../../test/helpers.ts'
import { context } from '../../../server/harness.ts'
import { git } from '../../../lib/git.ts'
import { updateSettings } from '../../../lib/settings.ts'

it('reports what an undecided project setup would add, validates first-run choices, and remembers the first run', async () => {
  const home = await temp('ultimate-onboarding-')
  const project = join(home, 'project')
  const userFile = join(home, '.ultimate/settings.json')
  await mkdir(join(project, '.ultimate/extensions/x'), { recursive: true })
  await mkdir(join(project, '.ultimate/agents'), { recursive: true })
  await mkdir(join(project, '.ultimate/skills/local-skill'), { recursive: true })
  await writeFile(
    join(project, '.ultimate/extensions/x/server.ts'),
    "import { defineExtension } from '@earendil-works/pi-durable'; export default defineExtension({ name: 'x' })",
  )
  await writeFile(
    join(project, '.ultimate/agents/y.md'),
    '---\nname: y\ndescription: Project agent\n---\nInspect the project.',
  )
  await writeFile(
    join(project, '.ultimate/skills/local-skill/SKILL.md'),
    '---\nname: local-skill\ndescription: Project skill\n---\nInspect.',
  )
  await writeFile(
    join(project, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['plan'] } }),
  )
  const options = {
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome: home,
    home: join(home, 'state'),
    localSetup: false,
    firstRun: true,
  }
  let server: Awaited<ReturnType<typeof fauxServer>> | undefined
  const action = async (name: string, args: unknown = {}) => {
    const response = await post(server!, `/api/extensions/onboarding/actions/${name}`, { args })
    expect(response.status).toBe(200)
    return response.data.result
  }
  try {
    server = await fauxServer(options)
    for (const args of [
      {},
      { extensions: { plan: 'yes' } },
      { extensions: {}, local: 1 },
      { extensions: { '': true } },
      { extensions: { ' ': false } },
    ])
      expect(
        (await post(server, '/api/extensions/onboarding/actions/applyFirstRun', { args })).status,
      ).toBe(500)
    // Undecided: the project's settings are not applied, but status shows what they would enable.
    expect(await action('status')).toMatchObject({
      firstRun: true,
      adds: {
        agents: ['y'],
        skills: ['local-skill'],
        extensions: ['x'],
        replaces: [],
        enable: [],
        disable: ['plan'],
      },
    })
    // `"onboarding": false` in the user's settings skips the first run without its marker.
    await updateSettings(userFile, (value) => {
      value.onboarding = false
    })
    expect(await action('status')).toMatchObject({ firstRun: false, off: true })
    await updateSettings(userFile, (value) => {
      delete value.onboarding
    })
    expect(await action('status')).toMatchObject({ firstRun: true, off: false })
    await action('firstRunDone')
    expect((await action('status')).firstRun).toBe(false)
    const first = server
    server = undefined
    await first.close()
    server = await fauxServer(options)
    expect((await action('status')).firstRun).toBe(false)
  } finally {
    await server?.close()
    await removeTemp(home)
  }
})

it('offers setup only to named definitions, refuses inapplicable cards, and deduplicates user-only choices', async () => {
  const home = await temp('ultimate-setup-cards-')
  const project = join(home, 'project')
  await mkdir(join(project, '.ultimate'), { recursive: true })
  await writeFile(join(project, '.ultimate/settings.json'), '{}')
  await mkdir(join(home, '.ultimate/agents'), { recursive: true })
  await writeFile(
    join(home, '.ultimate/agents/setup-guide.md'),
    '---\nname: setup-guide\ndescription: Setup guide\nresident: true\ntools: [setup, codemode]\n---\nHelp with setup.',
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome: home,
    home: join(home, 'state'),
    localSetup: false,
  })
  try {
    expect((await server.root.agent(context)).tools.map((tool) => tool.name)).not.toContain('setup')
    const route: FauxResponseFactory = (transcript) => {
      server.host.faux!.appendResponses([route])
      const last = transcript.messages.findLast((message) => message.role !== 'system')
      if (
        last?.role === 'user' &&
        typeof last.content === 'string' &&
        last.content.startsWith('CALL ')
      ) {
        const { name, args } = JSON.parse(last.content.slice(5))
        return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' })
      }
      return fauxAssistantMessage('Ready')
    }
    server.host.faux!.setResponses([route])
    const standing = await post(server, '/api/extensions/subagents/actions/standing', {
      args: { name: 'setup-guide' },
    })
    expect(standing.status).toBe(200)
    const conversation = (await server.harness.conversation(standing.data.result, context))!
    expect((await conversation.agent(context)).tools.map((tool) => tool.name)).toContain('setup')
    const run = async (name: string, args: Record<string, string>) => {
      await conversation.submit(
        { type: 'input', content: 'CALL ' + JSON.stringify({ name, args }) },
        context,
      )
      await server.harness.waitForIdle(context)
      const view = await conversation.context(context)
      return view.entries.findLast((entry) => entry.kind === 'pi.tool-result')!
    }
    expect(JSON.stringify(await run('setup', { card: 'project' }))).toContain('undecided')
    await post(server, '/api/extensions/manager/actions/decide', { args: { local: false } })
    expect(JSON.stringify(await run('setup', { card: 'project' }))).toContain('already decided')
    await git(project, 'init', '-b', 'main')
    await git(
      project,
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'base',
    )
    expect(JSON.stringify(await run('setup', { card: 'git' }))).toContain('already isolatable')
    expect(JSON.stringify(await run('setup', { card: 'extensions' }))).toContain(
      'Choose recommended extensions',
    )
    const choice = {
      card: 'extensions',
      extensions: { messages: true, faux: false, parallel: true },
      toolCallId: 'setup-1',
    }
    const receipts = await Promise.all(
      [0, 1].map(() =>
        post(server, '/api/extensions/onboarding/actions/choose', {
          args: choice,
          conversationId: conversation.id,
        }),
      ),
    )
    expect(receipts.map((receipt) => receipt.status)).toEqual([200, 200])
    await server.harness.waitForIdle(context)
    const entries = (await conversation.context(context)).entries.filter(
      (entry) => entry.kind === 'onboarding.choice',
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].data).toEqual({
      card: choice.card,
      toolCallId: choice.toolCallId,
      summary: 'enabled messages, parallel; disabled faux',
      missing: ['PARALLEL_API_KEY'],
    })
    expect(JSON.stringify(entries[0].model)).toContain(
      'Setup choice (extensions): enabled messages, parallel; disabled faux\\nMissing keys: PARALLEL_API_KEY. Ask the user',
    )
    const otherTab = await post(server, '/api/extensions/onboarding/actions/choose', {
      args: { ...choice, extensions: { messages: false, faux: true } },
      conversationId: conversation.id,
    })
    expect(otherTab.status).toBe(500)
    expect(otherTab.data.error).toContain('already has a different choice')
    expect(
      JSON.parse(await readFile(join(home, '.ultimate/settings.json'), 'utf8')).extensions,
    ).toMatchObject({ enable: ['messages', 'parallel'], disable: ['faux'] })

    // Fail after the setting is applied but before admission. Retrying must still notify the agent once.
    const retry = { card: 'project', local: true, toolCallId: 'retry-project' }
    const lookup = vi.spyOn(server.harness, 'conversation').mockResolvedValueOnce(conversation)
    const submit = vi
      .spyOn(conversation, 'submit')
      .mockRejectedValueOnce(new Error('Interrupted before notification'))
    try {
      const interrupted = await post(server, '/api/extensions/onboarding/actions/choose', {
        args: retry,
        conversationId: conversation.id,
      })
      expect(interrupted.status).toBe(500)
      expect(interrupted.data.error).toContain('Interrupted before notification')
    } finally {
      submit.mockRestore()
      lookup.mockRestore()
    }
    expect(server.system.current().project.decision).toBe(true)
    expect(
      (await conversation.context(context)).entries.filter(
        (entry) =>
          entry.kind === 'onboarding.choice' &&
          (entry.data as { toolCallId: string }).toolCallId === retry.toolCallId,
      ),
    ).toHaveLength(0)
    for (let i = 0; i < 2; i++)
      expect(
        (
          await post(server, '/api/extensions/onboarding/actions/choose', {
            args: retry,
            conversationId: conversation.id,
          })
        ).status,
      ).toBe(200)
    await server.harness.waitForIdle(context)
    expect(
      (await conversation.context(context)).entries.filter(
        (entry) =>
          entry.kind === 'onboarding.choice' &&
          (entry.data as { toolCallId: string }).toolCallId === retry.toolCallId,
      ),
    ).toHaveLength(1)
    expect(
      (
        await post(server, '/api/extensions/onboarding/actions/applyFirstRun', {
          args: { extensions: { info: false, plan: true } },
        })
      ).status,
    ).toBe(200)
    expect(
      JSON.parse(await readFile(join(home, '.ultimate/settings.json'), 'utf8')).extensions,
    ).toMatchObject({ enable: ['messages', 'parallel', 'plan'], disable: ['faux', 'info'] })
    expect(
      JSON.stringify(
        await run('codemode', {
          code: `return await tools.action({extension: 'onboarding', action: 'choose', args: ${JSON.stringify(choice)}});`,
        }),
      ),
    ).toContain('onboarding/choose is a user-only action')
    expect(
      JSON.stringify(
        await run('codemode', {
          code: "return await tools.action({extension: 'onboarding', action: 'start', args: {root: 1}});",
        }),
      ),
    ).toContain('onboarding/start is a user-only action')
    expect(
      JSON.stringify(
        await run('codemode', {
          code: "return await tools.action({extension: 'workspaces', action: 'setupGit'});",
        }),
      ),
    ).toContain('workspaces/setupGit is a user-only action')
    // Absence is checked independently of the remembered project decision.
    await rename(join(project, '.ultimate'), join(home, 'setup-backup'))
    expect(JSON.stringify(await run('setup', { card: 'project' }))).toContain('no .ultimate/ setup')
  } finally {
    await server.close()
    await removeTemp(home)
  }
})
