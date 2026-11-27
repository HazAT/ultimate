import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { requestChapter } from '../../../../lib/chapters.ts'
import { writeJson } from '../../../../lib/json-file.ts'
import { context } from '../../../../server/harness.ts'
import { Automations } from '../../../automations/server.ts'
import type { Seed } from '../../types.ts'
import { fauxServer, temp, until } from '../../../../test/helpers.ts'
import type { JsonValue } from '@earendil-works/chord/json'

let server: Awaited<ReturnType<typeof fauxServer>> | undefined
afterEach(async () => {
  const app = server
  server = undefined
  await app?.close()
})

/**
 * One script that records its fire in its persistent state and then stays quiet, saying which branch it took: the
 * receipt a finished script must still hold after a chapter rollover.
 */
const RUN = `#!/bin/sh
if [ -f "$AUTOMATION_STATE/fired" ]; then echo quiet >&2; sleep 300; exit 0; fi
echo FIRE once
echo fired > "$AUTOMATION_STATE/fired"
sleep 300
`

async function build() {
  const root = await temp('ultimate-dream-rearm-')
  const userHome = join(root, 'user')
  const home = join(root, 'project-state')
  const definitions = join(userHome, '.ultimate/agents')
  await mkdir(definitions, { recursive: true })
  for (const name of ['watcher', 'ultimate'])
    await writeFile(
      join(definitions, `${name}.md`),
      `---\nname: ${name}\ndescription: Automation test\nmodel: faux/faux-1\ntools: []\n${name === 'ultimate' ? 'resident: true\n' : ''}---\nKeep answers short.\n`,
    )
  await writeScript(join(root, '.ultimate/automations', 'watch-ci'), 'watch-ci', false)
  await writeScript(join(root, '.ultimate/automations', 'watch-done'), 'watch-done', true)
  const options = { ultimateRoot: resolve('.'), projectRoot: root, userHome, home }
  return {
    root,
    userHome,
    home,
    options,
    folder: (chapter: string, id: string) =>
      join(
        userHome,
        '.ultimate/automations',
        chapter === 'the-beginning' ? basename(home) : `${basename(home)}@${chapter}`,
        id,
      ),
  }
}

async function writeScript(dir: string, slug: string, once: boolean) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'run'), RUN)
  await chmod(join(dir, 'run'), 0o700)
  await writeJson(join(dir, 'automation.json'), { name: slug, ask: 'Watch the thing', once })
}

const record = async (id: string) =>
  (await server!.harness.snapshot(Automations, context))!.automations[id]

const output = async (chapter: string, id: string) =>
  readFile(join(buildCache.folder(chapter, id), 'output.log'), 'utf8').catch(() => '')
let buildCache: Awaited<ReturnType<typeof build>>

it('re-arms project scripts on rollover: a finished once script does not re-fire, an armed one resumes', async () => {
  buildCache = await build()
  server = await fauxServer(buildCache.options)
  const invoke = (action: string, args: JsonValue) =>
    server!.extensions.invoke('automations', action, args, new AbortController().signal)
  // Chapter one: the armed script fires once and finishes; the finished one already fired before.
  await invoke('list', {})
  await invoke('resume', { id: 'watch-ci' })
  await until(async () => (await record('watch-ci')).fires === 1)
  expect(await output('the-beginning', 'watch-ci')).toContain('FIRE once')
  await mkdir(join(buildCache.folder('the-beginning', 'watch-done'), 'state'), {
    recursive: true,
  })
  await writeFile(
    join(buildCache.folder('the-beginning', 'watch-done'), 'state', 'fired'),
    'sha:run\n',
  )

  const seed: Seed = {
    from: { name: 'the-beginning', number: 1 },
    learned: [],
    memories: {},
    todos: [],
    questions: [],
    automations: [],
    scripts: [
      {
        id: 'watch-ci',
        scope: 'project',
        name: 'watch-ci',
        ask: 'Watch the thing',
        once: false,
        armed: true,
      },
      {
        id: 'watch-done',
        scope: 'project',
        name: 'watch-done',
        ask: 'Watch the thing',
        once: true,
      },
    ],
    counts: { memories: 0, todos: 0, questions: 0, automations: 0, scripts: 2 },
    continues: {
      conversation: 1 as Seed['continues']['conversation'],
      handoff: 'Keep watching.',
    },
  }
  const next = join(buildCache.home, 'chapters', 'next')
  await mkdir(next, { recursive: true })
  await writeJson(join(next, 'seed.json'), seed)
  await server.close()
  await requestChapter(buildCache.home, 'next')
  server = await fauxServer(buildCache.options)

  // The armed script is running again, with its earlier state; the finished one stays disarmed.
  await until(async () => {
    const armed = await record('watch-ci')
    return armed.enabled && armed.script!.state === 'running' && !!armed.script!.pid
  })
  expect(await record('watch-done')).toMatchObject({
    enabled: false,
    script: { state: 'stopped' },
  })
  // The state receipts survived the chapter-isolated folders: the finished scripts do not fire again.
  expect(
    await readFile(join(buildCache.folder('next', 'watch-ci'), 'state', 'fired'), 'utf8'),
  ).toBe('fired\n')
  expect(
    await readFile(join(buildCache.folder('next', 'watch-done'), 'state', 'fired'), 'utf8'),
  ).toBe('sha:run\n')
  await until(async () => (await output('next', 'watch-ci')).includes('quiet'))
  expect((await record('watch-ci')).fires).toBe(0)
  expect(await output('next', 'watch-ci')).not.toContain('FIRE')
})
