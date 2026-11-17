// A standing agent's `sidebar.under-agent` rows sit under its own row in the Agents group, and under no other agent's.
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../../browser/server.ts'
import { fauxServer, post, removeTemp, temp } from '../../../../test/helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

/** A user extension that lists one row under @pr-lander only. */
const extension = `import { createElement } from 'react'
import { defineWebExtension, definePoint, provide } from '@/sdk'
const UnderAgent = definePoint('sidebar.under-agent')
const useRows = (name) => (name === 'pr-lander' ? createElement('div', { 'data-pr-row': '' }, 'PR 42') : null)
export default defineWebExtension({ provides: [provide(UnderAgent, useRows)] })
`
const agent = (name: string) =>
  `---\nname: ${name}\ndescription: ${name}\nresident: true\n---\nWait.\n`

it('draws an extension’s rows under the standing agent it names', async () => {
  const home = await temp('ultimate-under-agent-')
  cleanup.push(() => removeTemp(home))
  await mkdir(join(home, '.ultimate/extensions/pr-rows'), { recursive: true })
  await writeFile(join(home, '.ultimate/extensions/pr-rows/web.tsx'), extension)
  await mkdir(join(home, '.ultimate/agents'))
  for (const name of ['pr-lander', 'other'])
    await writeFile(join(home, `.ultimate/agents/${name}.md`), agent(name))
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  for (const name of ['pr-lander', 'other'])
    await post(server, '/api/extensions/subagents/actions/standing', {
      args: { name },
      conversationId: 1,
    })
  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    // Keep the profile in the test's TMPDIR, but let Chromium put its singleton socket in the short system temp path.
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage()
  await page.goto(`${server.url}/?conversation=1`)
  const agents = page.locator('[role="group"][aria-label="Agents"] > div')
  await page.locator('[data-pr-row]').waitFor()
  const blocks = await agents.evaluateAll((elements) =>
    elements.map((element) => ({
      agent: element.querySelector('[data-standing]')?.getAttribute('data-standing'),
      rows: element.querySelectorAll('[data-pr-row]').length,
    })),
  )
  expect(blocks).toEqual([
    { agent: 'other', rows: 0 },
    { agent: 'pr-lander', rows: 1 },
  ])
})
