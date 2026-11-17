import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { extensionGraph, problems, render } from '../scripts/deps.ts'
import { removeTemp, temp } from './helpers.ts'

const roots: string[] = []
afterAll(async () => {
  for (const root of roots.splice(0)) await removeTemp(root)
})
/** An `extensions/` folder holding `files` (path → source). */
async function extensions(files: Record<string, string>) {
  const root = await temp('ultimate-deps-')
  roots.push(root)
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), source)
  }
  return root
}
const core = "export const tier = 'core'\n"

it('reads runtime, type, re-export and dynamic imports and need/want of imported tokens', async () => {
  const graph = extensionGraph(
    await extensions({
      'base/api.ts': `${core}export const BaseApi = defineApi<S>()('base')\n`,
      'base/ui.tsx': 'export const Row = () => <div />\n',
      'other/api.ts': "export const OtherApi = defineApi<S>()('other')\n",
      'user/server.ts': `import { BaseApi } from '../base/api.ts'
import { OtherApi } from '../other/api.ts'
import type { S } from '../typed/api.ts'
export { Re } from '../reexported/api.ts'
export default (host) => { host.need(BaseApi); host.want(OtherApi); return import('../lazy/server.ts') }
`,
      'user/web/view.tsx': "import { Row } from '../../base/ui.tsx'\n",
      // Its tests are not part of an extension: what they import is no dependency of it.
      'user/test/user.test.ts': "import { Helper } from '../../tested/server.ts'\n",
      'tested/server.ts': '',
      'typed/api.ts': '',
      'reexported/api.ts': '',
      'lazy/server.ts': '',
    }),
  )
  expect(render(graph)).toEqual([
    'base*',
    'lazy',
    'other',
    'reexported',
    'tested',
    'typed',
    'user        → base(need) lazy other(want) reexported typed(type)',
  ])
  expect(problems(graph)).toEqual([])
})

it('fails on a cycle and on a core-tier extension that depends on an optional one, even for types', async () => {
  const graph = extensionGraph(
    await extensions({
      'low/api.ts': `${core}import type { High } from '../high/types.ts'\n`,
      'high/types.ts': "import { x } from '../mid/x.ts'\nexport type High = 1\n",
      'mid/x.ts': "export { y } from '../high/types.ts'\n",
    }),
  )
  expect(problems(graph)).toEqual([
    'cycle between high, mid',
    'low is core tier and depends on optional high (type)',
  ])
})
