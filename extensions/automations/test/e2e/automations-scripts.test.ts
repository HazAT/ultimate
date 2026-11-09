import { spawn } from 'node:child_process'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { Metadata } from '../../../../server/metadata.ts'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { JsonValue } from '@earendil-works/chord'
import type { ConversationId } from '@earendil-works/pi-durable'
import { Messages } from '../../../messages/api.ts'
import { launchHandshake, Automations } from '../../server.ts'
import { Done, Exited } from '../../refs.ts'
import type { Automation, AutomationListItem } from '../../types.ts'
import { requestChapter } from '../../../../lib/chapters.ts'
import { context } from '../../../../server/harness.ts'
import { eventHost, fauxServer, temp, until } from '../../../../test/helpers.ts'

let server: Awaited<ReturnType<typeof fauxServer>> | undefined
afterEach(async () => {
  const app = server
  server = undefined
  await app?.close()
})

async function fixture(localSetup = true) {
  const root = await temp('ultimate-automations-')
  const userHome = join(root, 'user')
  const home = join(root, 'project-state')
  const definitions = join(userHome, '.ultimate/agents')
  await mkdir(definitions, { recursive: true })
  for (const name of ['watcher', 'ultimate'])
    await writeFile(
      join(definitions, `${name}.md`),
      `---\nname: ${name}\ndescription: Automation test\nmodel: faux/faux-1\ntools: []\n${name === 'ultimate' ? 'resident: true\n' : ''}---\nKeep answers short.\n`,
    )
  const options = { ultimateRoot: resolve('.'), projectRoot: root, userHome, home, localSetup }
  server = await fauxServer(options)
  return {
    root,
    userHome,
    home,
    options,
    app: server,
    folder: (id: string) => join(userHome, '.ultimate/automations', basename(home), id),
  }
}
async function create(app: NonNullable<typeof server>) {
  const caller = await app.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  return (await app.extensions.invoke(
    'automations',
    'create',
    { name: 'Watch', ask: 'Watch this script' },
    new AbortController().signal,
    caller.id,
  )) as Automation
}
async function writeRun(folder: string, script: string) {
  await mkdir(join(folder, 'state'), { recursive: true })
  await writeFile(join(folder, 'run'), `#!/bin/sh\n${script}\n`)
  await chmod(join(folder, 'run'), 0o700)
}
function call(app: NonNullable<typeof server>, action: string, id: string) {
  return app.extensions.invoke('automations', action, { id }, new AbortController().signal)
}

it('starts a prompt run from script FIRE with its payload', async () => {
  const { app, folder } = await fixture()
  app.host.faux!.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage('Complete')))
  const caller = await app.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  const a = (await app.extensions.invoke(
    'automations',
    'create',
    {
      name: 'Summary',
      ask: 'Watch',
      prompt: 'Summarize',
    },
    new AbortController().signal,
    caller.id,
  )) as Automation
  expect(a.subscribers).toEqual([])
  await app.extensions.invoke(
    'automations',
    'subscribe',
    { id: a.id, to: `#${caller.id}` },
    new AbortController().signal,
  )
  await writeRun(folder(a.id), 'echo FIRE hello')
  await call(app, 'resume', a.id)
  const record = async () => (await app.harness.snapshot(Automations, context))!.automations[a.id]
  await until(async () => !!(await record()).runs[0]?.finishedAt)
  const run = (await record()).runs[0]
  expect(run.status).toBe('done')
  const child = (await app.harness.conversation(run.conversationId!, context))!
  const entries = (await child.context(context)).entries.filter(
    (e) => e.conversationId === child.id,
  )
  const first = entries.find((e) => e.kind === 'pi.user')!.model![0]
  expect(first.content).toContain('Summarize')
  expect(first.content).toContain('Fired: hello')
  expect((await app.harness.snapshot(Metadata, child.id, context))?.label).toBe('automation')
  const fired = async () =>
    (await (await app.harness.conversation(caller.id, context))!.context(context)).entries.filter(
      (e) => e.conversationId === caller.id && e.kind === 'automations.fired',
    )
  await until(async () => (await fired()).length === 1)
  expect((await fired())[0].data).toEqual({ id: a.id, name: 'Summary', text: 'hello' })
  expect(await record()).toMatchObject({ fires: 1, enabled: false, script: { state: 'done' } })
})

it('delivers FIRE once, investigates exits only in the owning agent, recovers, and escalates through Messages', async () => {
  const { root, userHome, home, options, app: initial } = await fixture()
  let app = initial
  const caller = await app.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  const invoke = (action: string, args: JsonValue = null) =>
    app.extensions.invoke('automations', action, args, new AbortController().signal, caller.id)
  const get = async (id: string) =>
    (await app.harness.snapshot(Automations, context))!.automations[id]
  const entries = async (id: number, kind: string) => {
    const conversation = (await app.harness.conversation(id as ConversationId, context))!
    return (await conversation.context(context)).entries.filter(
      (e) => e.conversationId === id && e.kind === kind,
    )
  }
  const script = async (id: string, text: string) => {
    const dir = join(userHome, '.ultimate/automations', basename(home), id)
    await mkdir(join(dir, 'state'), { recursive: true })
    await writeFile(join(dir, 'run'), `#!/bin/sh\n${text}\n`)
    await chmod(join(dir, 'run'), 0o700)
  }
  const first = (await invoke('create', {
    ask: 'Wake me when this finishes',
    name: 'CI',
  })) as Automation
  expect(first).toMatchObject({
    id: 'A1',
    subscribers: [caller.id],
    script: { state: 'writing', once: true },
  })
  await script(first.id, 'sleep 2; echo FIRE done')
  await invoke('resume', { id: first.id })
  await until(
    async () =>
      (await get(first.id)).script!.state === 'done' &&
      (await entries(caller.id, 'automations.fired')).length === 1,
  )
  expect((await entries(caller.id, 'automations.fired'))[0].data).toMatchObject({
    id: first.id,
    name: 'CI',
    text: 'done',
  })
  expect(await get(first.id)).toMatchObject({ enabled: false, fires: 1 })

  const second = (await invoke('create', {
    ask: 'Watch a failing process',
    name: 'Failure',
  })) as Automation
  await script(second.id, 'echo broken >&2; exit 3')
  await invoke('resume', { id: second.id })
  await until(
    async () => (await entries(second.script!.conversationId, 'automations.failed')).length === 1,
  )
  expect(await get(second.id)).toMatchObject({ script: { state: 'investigating', exitCode: 3 } })
  expect(await entries(caller.id, 'automations.failed')).toHaveLength(0)
  expect(
    JSON.stringify(await entries(second.script!.conversationId, 'automations.failed')),
  ).toContain('code 3')
  expect(await invoke('log', { id: second.id })).toEqual({ text: 'broken' })
  // Recovery itself never wakes subscribers; only the eventual FIRE does.
  await script(second.id, 'echo FIRE recovered')
  await invoke('resume', { id: second.id })
  await until(
    async () =>
      (await get(second.id)).script!.state === 'done' &&
      (await entries(caller.id, 'automations.fired')).length === 2,
  )
  expect(await entries(caller.id, 'automations.escalated')).toHaveLength(0)

  const third = (await invoke('create', { name: 'Watch', ask: 'This cannot work' })) as Automation
  await invoke('escalate', { id: third.id, reason: 'No access to the remote system' })
  await until(async () => (await entries(caller.id, 'automations.escalated')).length === 1)
  expect(await get(third.id)).toMatchObject({ enabled: false, script: { state: 'failed' } })
  const messages = (await app.harness.snapshot(Messages, 1 as ConversationId, context))!.messages
  expect(
    messages.filter(
      (m) =>
        m.from === third.script!.conversationId &&
        m.text.includes('No access to the remote system'),
    ),
  ).toHaveLength(1)
  await invoke('delete', { id: third.id })
  expect((await app.harness.snapshot(Automations, context))!.automations[third.id]).toBeUndefined()
  expect(
    await app.harness.conversation(third.script!.conversationId as ConversationId, context),
  ).toBeDefined()

  const recurring = (await invoke('create', {
    name: 'Watch',
    ask: 'Keep watching',
    once: false,
  })) as Automation
  await script(recurring.id, 'echo FIRE tick; exit 0')
  await invoke('resume', { id: recurring.id })
  await until(
    async () =>
      (await entries(recurring.script!.conversationId, 'automations.failed')).length === 1,
  )
  expect(await get(recurring.id)).toMatchObject({
    fires: 1,
    script: { state: 'investigating', exitCode: 0 },
  })

  const restart = (await invoke('create', {
    name: 'Watch',
    ask: 'Survive a server reopen',
  })) as Automation
  await script(restart.id, 'echo stopping; sleep 60')
  const beforeRestart = (await invoke('resume', { id: restart.id })) as Automation
  const afterRestart = (await invoke('run', { id: restart.id })) as Automation
  expect(afterRestart.script!.pid).not.toBe(beforeRestart.script!.pid)
  await invoke('pause', { id: restart.id })
  await until(async () => !!(await get(restart.id)).script!.exitedAt)
  expect(await get(restart.id)).toMatchObject({ enabled: false, script: { state: 'stopped' } })
  expect(await entries(restart.script!.conversationId, 'automations.failed')).toHaveLength(0)
  // A changed ask stops the running script and sends the watcher back to writing, as at creation.
  await invoke('resume', { id: restart.id })
  const watching = (await get(restart.id)).script!.pid!
  const rewritten = (await invoke('update', {
    id: restart.id,
    ask: 'Survive a server reopen, then fire',
  })) as Automation
  expect(rewritten.script).toMatchObject({
    state: 'writing',
    ask: 'Survive a server reopen, then fire',
  })
  await until(() => {
    try {
      process.kill(watching, 0)
      return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
      throw error
    }
  })
  await until(
    async () => (await entries(restart.script!.conversationId, 'automations.writing')).length === 2,
  )
  expect((await get(restart.id)).script!.state).toBe('writing')
  await script(
    restart.id,
    'if [ -e "$AUTOMATION_STATE/ready" ]; then echo FIRE resumed; else touch "$AUTOMATION_STATE/ready"; echo ready-for-reopen; sleep 60; fi',
  )
  await invoke('resume', { id: restart.id })
  await until(async () =>
    ((await invoke('log', { id: restart.id })) as { text: string }).text.includes(
      'ready-for-reopen',
    ),
  )
  await app.close()
  server = undefined
  app = await fauxServer(options)
  server = app
  await until(
    async () =>
      (await get(restart.id)).script!.state === 'done' &&
      (await entries(caller.id, 'automations.fired')).length === 4,
  )
  expect(
    (await entries(caller.id, 'automations.fired')).map((e) => (e.data as { text: string }).text),
  ).toEqual(['done', 'recovered', 'tick', 'resumed'])

  const disabled = (await invoke('create', {
    name: 'Watch',
    ask: 'Stop with the optional extension',
  })) as Automation
  await script(disabled.id, 'sleep 60')
  const running = (await invoke('resume', { id: disabled.id })) as Automation
  await mkdir(join(root, '.ultimate'), { recursive: true })
  await writeFile(
    join(root, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['automations'] } }),
  )
  await until(() => app.extensions.info().some((e) => e.name === 'automations' && !e.enabled))
  await until(() => {
    try {
      process.kill(running.script!.pid!, 0)
      return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
      throw error
    }
  })
})

it('escalates on the third failure in a row, and when its watcher ends a turn without repairing', async () => {
  const { app, folder } = await fixture()
  const caller = await app.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  const invoke = (action: string, args: JsonValue) =>
    app.extensions.invoke('automations', action, args, new AbortController().signal, caller.id)
  const get = async (id: string) =>
    (await app.harness.snapshot(Automations, context))!.automations[id]
  const escalated = async () =>
    (await (await app.harness.conversation(caller.id, context))!.context(context)).entries.filter(
      (e) => e.conversationId === caller.id && e.kind === 'automations.escalated',
    )
  // Regression: a crash-looping script stayed `investigating` as long as its watcher kept resuming it.
  const crash = (await invoke('create', { name: 'Crash', ask: 'Crash loop' })) as Automation
  await writeRun(folder(crash.id), 'exit 1')
  for (const failures of [1, 2]) {
    await invoke('resume', { id: crash.id })
    await until(async () => (await get(crash.id)).script!.failures === failures)
    expect((await get(crash.id)).script!.state).toBe('investigating')
  }
  await invoke('resume', { id: crash.id })
  await until(async () => (await escalated()).length === 1)
  expect(await get(crash.id)).toMatchObject({
    enabled: false,
    script: {
      state: 'failed',
      failures: 3,
      error: 'Failed 3 times in a row: Process exited with code 1',
    },
  })

  // Regression: a watcher that answered without resuming or escalating left its script `writing` for good.
  const answer = () => {
    app.host.faux!.appendResponses([answer])
    return fauxAssistantMessage('I could not find the CI API.')
  }
  app.host.faux!.setResponses([answer])
  const stalled = (await invoke('create', { name: 'Stalled', ask: 'Watch CI' })) as Automation
  await until(async () => (await escalated()).length === 2)
  expect(await get(stalled.id)).toMatchObject({
    enabled: false,
    script: {
      state: 'failed',
      error: 'The watcher stopped while the script was writing: I could not find the CI API.',
    },
  })
})

it('stops a recurring script that prints DONE and exits 0 without waking anyone; start resumes it with its state', async () => {
  const { app, folder } = await fixture()
  const sub = (await app.extensions.invoke(
    'automations',
    'create',
    { name: 'Watch', ask: 'Poll until merged', once: false },
    new AbortController().signal,
    (await app.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)).id,
  )) as Automation
  const get = async () => (await app.harness.snapshot(Automations, context))!.automations[sub.id]
  const inputs = async (id: number) =>
    (
      await (await app.harness.conversation(id as ConversationId, context))!.context(context)
    ).entries
      .filter((e) => e.conversationId === id && e.kind.startsWith('automations.'))
      .map((e) => e.kind)
  const done = () => eventHost(() => app.harness, 'test').eventLog.recent({ events: [Done] })
  // Each run counts itself in its state folder, fires the count and stops itself.
  await writeRun(
    folder(sub.id),
    'n=$(($(cat "$AUTOMATION_STATE/n" 2>/dev/null || echo 0) + 1)); echo $n > "$AUTOMATION_STATE/n"; echo FIRE $n; echo DONE all merged',
  )
  await call(app, 'resume', sub.id)
  await until(async () => !!(await get()).script!.exitedAt)
  expect(await get()).toMatchObject({
    enabled: false,
    fires: 1,
    script: { state: 'stopped', exitCode: 0 },
  })
  expect((await get()).script!.error).toBeUndefined()
  expect((await done()).map((e) => e.data)).toEqual([{ id: sub.id, text: 'all merged' }])
  await call(app, 'resume', sub.id)
  await until(async () => (await get()).fires === 2 && (await get()).script!.state === 'stopped')
  expect(await readFile(join(folder(sub.id), 'state/n'), 'utf8')).toBe('2\n')
  const subscriber = sub.subscribers[0] as number
  await until(async () => (await inputs(subscriber)).length === 2)
  expect(await inputs(subscriber)).toEqual(['automations.fired', 'automations.fired'])
  // The owning agent got only its writing brief: no failure input.
  expect(await inputs(sub.script!.conversationId)).toEqual(['automations.writing'])

  // DONE followed by a non-zero exit stays a failure.
  await writeRun(folder(sub.id), 'echo DONE; exit 2')
  await call(app, 'resume', sub.id)
  await until(async () => (await get()).script!.state === 'investigating')
  expect(await get()).toMatchObject({ enabled: true, script: { exitCode: 2 } })
  await until(async () => (await inputs(sub.script!.conversationId)).includes('automations.failed'))
  expect(await done()).toHaveLength(2)

  // A one-shot cannot DONE: exiting without a FIRE still fails, so its subscribers are not left waiting.
  const once = await create(app)
  await writeRun(folder(once.id), 'echo DONE')
  await call(app, 'resume', once.id)
  await until(
    async () =>
      (await app.harness.snapshot(Automations, context))!.automations[once.id].script!.state ===
      'investigating',
  )
  expect(await done()).toHaveLength(2)
})

it("keeps a later chapter's scripts in their own folder, apart from the first chapter's same id", async () => {
  const first = await fixture()
  const legacy = first.folder('A1')
  await mkdir(join(legacy, 'state'), { recursive: true })
  await writeFile(join(legacy, 'state/mark'), 'first chapter\n')
  const { home, userHome } = first
  await server?.close()
  server = undefined
  await requestChapter(home, 'next')
  server = await fauxServer({ ...first.options, home, userHome })
  const sub = await create(server)
  expect(sub.id).toBe('A1')
  const folder = join(userHome, '.ultimate/automations', `${basename(home)}@next`, 'A1')
  await writeRun(folder, 'echo FIRE later; sleep 60')
  await call(server, 'resume', sub.id)
  await until(async () =>
    (await readFile(join(folder, 'output.log'), 'utf8').catch(() => '')).includes('FIRE later'),
  )
  // The first chapter's folder is untouched: no run, no log, its state kept.
  expect(await readFile(join(legacy, 'state/mark'), 'utf8')).toBe('first chapter\n')
  await expect(readFile(join(legacy, 'output.log'), 'utf8')).rejects.toThrow('ENOENT')
  await call(server, 'pause', sub.id)
})

it('keeps listing and supervising scripts after a reload bumps the ledger version', async () => {
  const { app, folder } = await fixture()
  const sub = await create(app)
  const get = async () =>
    (
      (await app.extensions.invoke(
        'automations',
        'list',
        null,
        new AbortController().signal,
      )) as AutomationListItem[]
    ).find((a) => a.id === sub.id)!
  await writeRun(folder(sub.id), 'sleep 60')
  const before = (await call(app, 'resume', sub.id)) as Automation
  // ultimateRoot is an isolated source copy; never mutate the working checkout here.
  const file = join(app.host.ultimateRoot, 'extensions/automations/server.ts')
  const source = await readFile(file, 'utf8')
  const loaded = () => app.extensions.info().find((e) => e.name === 'automations')!.server!.loadedAt
  const previous = loaded()
  const bumped = source.replace('  version: 3,\n  scope: ', '  version: 4,\n  scope: ')
  expect(bumped).not.toBe(source)
  await writeFile(file, bumped)
  app.vite.watcher.emit('change', file)
  await until(() => loaded() !== previous)
  // A reload restarts running scripts on the new code, as a core swap does.
  await until(async () => {
    const now = await get()
    return now.alive && now.script!.pid !== before.script!.pid
  })
  // The new token migrates the ledger to version 4 on its next write; the supervisor must use it too.
  await call(app, 'pause', sub.id)
  await until(async () => !!(await get()).script!.exitedAt)
  expect(await get()).toMatchObject({ enabled: false, script: { state: 'stopped' } })
  await writeRun(folder(sub.id), 'echo FIRE after')
  await call(app, 'resume', sub.id)
  await until(async () => (await get()).fires === 1)
})

/** A recurring project automation committed in `root`'s `.ultimate/automations/<slug>/`. */
async function committed(root: string, slug: string, script: string) {
  const dir = join(root, '.ultimate/automations', slug)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'automation.json'),
    JSON.stringify({ name: 'Ship PRs', ask: 'Poll ship/* PRs', once: false }),
  )
  await writeFile(join(dir, 'run'), `#!/bin/sh\n${script}\n`)
  await chmod(join(dir, 'run'), 0o700)
}
/** Project records only: dream can independently register its built-in event automation. */
async function list(app: NonNullable<typeof server>) {
  const automations = (await app.extensions.invoke(
    'automations',
    'list',
    null,
    new AbortController().signal,
  )) as Automation[]
  return automations.filter((a) => a.scope === 'project')
}

it('discovers a committed project automation by slug only in a chosen project, and starts, stops and DONEs it there', async () => {
  // Not chosen as local: the committed folder is ignored and cannot be addressed.
  const untrusted = await fixture(false)
  await committed(untrusted.root, 'prs', 'echo FIRE never')
  expect(await list(untrusted.app)).toEqual([])
  await expect(call(untrusted.app, 'resume', 'prs')).rejects.toThrow('Unknown automation: prs')
  await untrusted.app.close()
  server = undefined

  const { root, app, folder } = await fixture()
  // It runs in the project checkout and keeps state in the machine-local folder.
  await committed(
    root,
    'prs',
    'pwd > "$AUTOMATION_STATE/cwd"; echo 1 > "$AUTOMATION_STATE/n"; echo FIRE 1; sleep 60',
  )
  const [found] = await list(app)
  expect(found).toMatchObject({
    id: 'prs',
    scope: 'project',
    name: 'Ship PRs',
    enabled: false,
    // Regression: discovered project scripts woke nobody. The manifest's `to` defaults to @ultimate.
    subscribers: ['@ultimate'],
    script: { once: false, state: 'stopped', to: '@ultimate' },
  })
  // Discovery never starts it; its agent conversation exists, idle.
  expect(found.script?.pid).toBeUndefined()
  expect(
    await app.harness.conversation(found.script?.conversationId as ConversationId, context),
  ).toBeDefined()
  expect((await list(app)).map((s) => s.script!.conversationId)).toEqual([
    found.script?.conversationId,
  ])

  const get = async () => (await app.harness.snapshot(Automations, context))!.automations.prs
  const started = (await call(app, 'resume', 'prs')) as Automation
  expect(started).toMatchObject({ enabled: true, script: { state: 'running' } })
  await until(async () => (await get()).fires === 1)
  expect(await readFile(join(folder('prs'), 'state/cwd'), 'utf8')).toBe(`${root}\n`)
  expect(await readFile(join(folder('prs'), 'output.log'), 'utf8')).toContain('FIRE 1')
  await expect(readFile(join(root, '.ultimate/automations/prs/output.log'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
  await call(app, 'pause', 'prs')
  await until(async () => !!(await get()).script!.exitedAt)
  expect(await get()).toMatchObject({ enabled: false, script: { state: 'stopped' } })
  await expect(readFile(join(folder('prs'), 'pid'))).rejects.toMatchObject({ code: 'ENOENT' })

  // An edited run is picked up on the next start, with its state kept; DONE then exit 0 stops it cleanly.
  await committed(
    root,
    'prs',
    'n=$(($(cat "$AUTOMATION_STATE/n") + 1)); echo $n > "$AUTOMATION_STATE/n"; echo FIRE $n; echo DONE nothing left',
  )
  await call(app, 'resume', 'prs')
  await until(async () => (await get()).fires === 2 && (await get()).script!.state === 'stopped')
  expect(await get()).toMatchObject({ enabled: false, script: { exitCode: 0 } })
  expect((await get()).script!.error).toBeUndefined()
  const done = await eventHost(() => app.harness, 'test').eventLog.recent({ events: [Done] })
  expect(done.map((e) => e.data)).toEqual([{ id: 'prs', text: 'nothing left' }])

  // A removed folder forgets the record.
  await rm(join(root, '.ultimate/automations/prs'), { recursive: true })
  expect(await list(app)).toEqual([])
})

it('creates a project automation in the checkout with a committed manifest', async () => {
  const { root, app } = await fixture()
  const caller = await app.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  // A create that fails before it has an agent leaves the slug free for the retry.
  await expect(
    app.extensions.invoke(
      'automations',
      'create',
      { ask: 'Poll ship PRs', name: 'Ship PRs', scope: 'project' },
      new AbortController().signal,
      999_999,
    ),
  ).rejects.toThrow('Unknown caller #999999')
  const sub = (await app.extensions.invoke(
    'automations',
    'create',
    {
      ask: 'Poll ship PRs',
      name: 'Ship PRs',
      once: false,
      scope: 'project',
      secrets: ['GH_TOKEN'],
    },
    new AbortController().signal,
    caller.id,
  )) as Automation
  expect(sub).toMatchObject({
    id: 'ship-prs',
    scope: 'project',
    subscribers: ['@ultimate', caller.id],
    script: { state: 'writing' },
  })
  expect(
    JSON.parse(
      await readFile(join(root, '.ultimate/automations/ship-prs/automation.json'), 'utf8'),
    ),
  ).toEqual({ name: 'Ship PRs', ask: 'Poll ship PRs', once: false, secrets: ['GH_TOKEN'] })
  // Discovery keeps the created record and its agent.
  const listed = await list(app)
  expect(listed).toMatchObject([
    { id: 'ship-prs', script: { conversationId: sub.script!.conversationId, state: 'writing' } },
  ])
  await expect(
    app.extensions.invoke(
      'automations',
      'create',
      { ask: 'Again', name: 'Ship PRs', scope: 'project' },
      new AbortController().signal,
      caller.id,
    ),
  ).rejects.toThrow('Automation ship-prs already exists')
  // The identical create (as a replay would send it) cannot reset a record that has been used either.
  await expect(
    app.extensions.invoke(
      'automations',
      'create',
      {
        ask: 'Poll ship PRs',
        name: 'Ship PRs',
        once: false,
        scope: 'project',
        secrets: ['GH_TOKEN'],
      },
      new AbortController().signal,
      caller.id,
    ),
  ).rejects.toThrow('Automation ship-prs already exists')
  expect((await list(app))[0]).toMatchObject({
    subscribers: ['@ultimate', caller.id],
    script: { state: 'writing' },
  })

  await app.extensions.invoke(
    'automations',
    'update',
    {
      id: sub.id,
      name: 'Updated',
      ask: 'Watch merged PRs',
      once: true,
      secrets: [],
      prompt: 'Summarize',
    },
    new AbortController().signal,
  )
  expect(
    JSON.parse(
      await readFile(join(root, '.ultimate/automations/ship-prs/automation.json'), 'utf8'),
    ),
  ).toEqual({
    name: 'Updated',
    ask: 'Watch merged PRs',
    once: true,
  })
  expect((await list(app)).find((a) => a.id === sub.id)).toMatchObject({
    name: 'Updated',
    prompt: 'Summarize',
    // Regression: discovery applied the new ask first, so the watcher was never sent back to writing.
    script: { ask: 'Watch merged PRs', once: true, state: 'writing' },
  })
  const watcherInputs = async () =>
    (
      await (await app.harness.conversation(
        sub.script!.conversationId as ConversationId,
        context,
      ))!.context(context)
    ).entries.filter((e) => e.kind === 'automations.writing')
  await until(async () => (await watcherInputs()).length === 2)

  // Two creates racing for one slug: exactly one publishes and takes the record; the other is refused.
  const racing = await Promise.allSettled(
    ['Poll A', 'Poll B'].map((ask) =>
      app.extensions.invoke(
        'automations',
        'create',
        { ask, name: 'Race', scope: 'project' },
        new AbortController().signal,
        caller.id,
      ),
    ),
  )
  expect(racing.map((r) => r.status).toSorted()).toEqual(['fulfilled', 'rejected'])
  const won = (racing.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Automation>)
    .value
  expect(
    JSON.parse(await readFile(join(root, '.ultimate/automations/race/automation.json'), 'utf8'))
      .ask,
  ).toBe(won.script!.ask)

  // A discovered, unused record with the same manifest is taken by the create, with its agent: a create that crashed
  // after publishing its manifest replays to it. Inherited object keys are no slugs.
  await committed(root, 'ship-prs-2', 'true')
  const discovered = (await list(app)).find((s) => s.id === 'ship-prs-2')!
  const adopted = (await app.extensions.invoke(
    'automations',
    'create',
    {
      ask: 'Poll ship/* PRs',
      name: 'Ship PRs',
      once: false,
      scope: 'project',
      slug: 'ship-prs-2',
    },
    new AbortController().signal,
    caller.id,
  )) as Automation
  expect(adopted).toMatchObject({
    subscribers: ['@ultimate', caller.id],
    script: { conversationId: discovered.script?.conversationId, state: 'writing' },
  })
  // A manifest naming another standing agent wakes it instead, and the record follows an edit.
  await writeFile(
    join(root, '.ultimate/automations/ship-prs-2/automation.json'),
    JSON.stringify({ name: 'Ship PRs', ask: 'Poll ship/* PRs', once: false, to: '@reviewer' }),
  )
  expect((await list(app)).find((s) => s.id === 'ship-prs-2')).toMatchObject({
    subscribers: [caller.id, '@reviewer'],
    script: { to: '@reviewer' },
  })
  await expect(
    app.extensions.invoke(
      'automations',
      'create',
      { name: 'Watch', ask: 'x', scope: 'project', slug: 'constructor' },
      new AbortController().signal,
      caller.id,
    ),
  ).rejects.toThrow('not be an object key')
})

it('waits for a SIGTERM-ignoring script to die before stop returns and removes its pid file', async () => {
  const { app, folder } = await fixture()
  const sub = await create(app)
  await writeRun(folder(sub.id), "trap '' TERM; echo ready; exec sleep 60")
  const running = (await call(app, 'resume', sub.id)) as Automation
  await until(async () =>
    ((await call(app, 'log', sub.id)) as { text: string }).text.includes('ready'),
  )
  expect(Number(await readFile(join(folder(sub.id), 'pid'), 'utf8'))).toBe(running.script!.pid)
  await call(app, 'pause', sub.id)
  expect(() => process.kill(-running.script!.pid!, 0)).toThrow(
    expect.objectContaining({ code: 'ESRCH' }),
  )
  await expect(readFile(join(folder(sub.id), 'pid'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['pause', 'delete'])(
  'awaits %s of a fired one-shot during its termination grace period',
  async (action) => {
    const { app, folder } = await fixture()
    const sub = await create(app)
    await writeRun(folder(sub.id), 'trap "" TERM; echo FIRE done; exec sleep 60')
    await call(app, 'resume', sub.id)
    await until(
      async () =>
        (await app.harness.snapshot(Automations, context))!.automations[sub.id].script!.state ===
        'done',
    )
    const pid = Number(await readFile(join(folder(sub.id), 'pid'), 'utf8'))
    expect((await app.harness.snapshot(Automations, context))!.automations[sub.id]).toMatchObject({
      enabled: false,
      script: { state: 'done', pid },
    })
    expect(process.kill(-pid, 0)).toBe(true)
    await call(app, action, sub.id)
    expect(() => process.kill(-pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    await expect(readFile(join(folder(sub.id), 'pid'))).rejects.toMatchObject({ code: 'ENOENT' })
    const saved = (await app.harness.snapshot(Automations, context))!.automations[sub.id]
    // A fired one-shot stays done: pausing its lingering process is not a stop.
    const stopped = expect.objectContaining({
      enabled: false,
      script: expect.objectContaining({ state: 'done', exitedAt: expect.any(Number) }),
    })
    expect(saved).toEqual(action === 'delete' ? undefined : stopped)
    expect(saved?.script?.pid).toBeUndefined()
  },
)

it.each([false, true])(
  'launch handshake go=%s: EOF aborts; exec keeps the pid and gives the script empty stdin',
  async (go) => {
    const root = await temp('ultimate-automation-handshake-')
    await writeRun(
      root,
      'echo "$$"; if read -r value; then echo unexpected-input; else echo eof; fi',
    )
    const child = spawn('/bin/sh', ['-c', launchHandshake, join(root, 'run')], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (done, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => done({ code, signal }))
      },
    )
    child.stdin.end(go ? '\n' : undefined)
    expect(await exited).toEqual({ code: go ? 0 : 1, signal: null })
    expect(output).toBe(go ? `${child.pid}\neof\n` : '')
    expect(() => process.kill(-child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  },
)

it('records the exit metadata and event for a successful done one-shot without a failure', async () => {
  const { app, folder } = await fixture()
  const sub = await create(app)
  await writeRun(folder(sub.id), "trap 'exit 0' TERM; echo FIRE done; while :; do :; done")
  await call(app, 'resume', sub.id)
  await until(
    async () =>
      !!(await app.harness.snapshot(Automations, context))!.automations[sub.id].script!.exitedAt,
  )
  const saved = (await app.harness.snapshot(Automations, context))!.automations[sub.id]
  expect(saved).toMatchObject({ enabled: false, fires: 1, script: { state: 'done', exitCode: 0 } })
  expect(saved.script?.pid).toBeUndefined()
  const events = await eventHost(() => app.harness, 'test').eventLog.recent({ events: [Exited] })
  expect(events.filter((event) => event.data.id === sub.id).map((event) => event.data)).toEqual([
    { id: sub.id, code: 0 },
  ])
  const agent = (await app.harness.conversation(
    sub.script!.conversationId as ConversationId,
    context,
  ))!
  expect(
    (await agent.context(context)).entries.filter((entry) => entry.kind === 'automations.failed'),
  ).toHaveLength(0)
})

it('sweeps a crashed process pid file even when no automation record exists', async () => {
  const { app, folder, options } = await fixture()
  await app.close()
  server = undefined
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
  const exited = new Promise<void>((done) => child.once('close', () => done()))
  try {
    await mkdir(folder('A999'), { recursive: true })
    await writeFile(join(folder('A999'), 'pid'), `${child.pid}\n`)
    server = await fauxServer(options)
    await exited
    expect(() => process.kill(-child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    await expect(readFile(join(folder('A999'), 'pid'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, 'SIGKILL')
    await exited
  }
})

it('commits a one-shot as done before termination and never starts it again on reopen', async () => {
  const { app, folder, options } = await fixture()
  const sub = await create(app)
  await writeRun(
    folder(sub.id),
    'trap "" TERM; echo started >> "$AUTOMATION_STATE/starts"; echo FIRE done; exec sleep 60',
  )
  await call(app, 'resume', sub.id)
  await until(
    async () =>
      (await app.harness.snapshot(Automations, context))!.automations[sub.id].script!.state ===
      'done',
  )
  expect((await app.harness.snapshot(Automations, context))!.automations[sub.id]).toMatchObject({
    enabled: false,
    fires: 1,
  })
  await app.close()
  server = undefined
  server = await fauxServer(options)
  expect((await server.harness.snapshot(Automations, context))!.automations[sub.id]).toMatchObject({
    enabled: false,
    fires: 1,
    script: { state: 'done' },
  })
  expect(await readFile(join(folder(sub.id), 'state/starts'), 'utf8')).toBe('started\n')
  await expect(readFile(join(folder(sub.id), 'pid'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('closes during a pending start without spawning a process after cleanup', async () => {
  const { app, folder } = await fixture()
  const sub = await create(app)
  await writeRun(folder(sub.id), 'echo $$ > "$AUTOMATION_STATE/started"; exec sleep 60')
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  let held = false
  const original = app.harness.snapshot.bind(app.harness) as (
    ...args: unknown[]
  ) => Promise<unknown>
  // Snapshot is overloaded; preserve its API while holding this specific launch before its async file work.
  const snapshot = vi.spyOn(app.harness, 'snapshot').mockImplementation((async (
    ...args: unknown[]
  ) => {
    const result = await original(...args)
    if (
      !held &&
      (args[0] as typeof Automations).definition.kind === Automations.definition.kind &&
      (result as { automations: Record<string, Automation> })?.automations[sub.id]?.script
        ?.state === 'running'
    ) {
      held = true
      entered.resolve()
      await resume.promise
    }
    return result
  }) as typeof app.harness.snapshot)
  try {
    const starting = call(app, 'resume', sub.id).then(
      () => '',
      (error: unknown) => String(error),
    )
    await entered.promise
    // Release invokes the same supervisor close callback synchronously, before full host shutdown awaits it.
    const releasing = app.extensions.released()
    const closing = app.close()
    resume.resolve()
    expect(await starting).toContain('supervisor is closing')
    await releasing
    await closing
    server = undefined
    await expect(readFile(join(folder(sub.id), 'pid'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(folder(sub.id), 'state/started'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  } finally {
    resume.resolve()
    snapshot.mockRestore()
  }
})
