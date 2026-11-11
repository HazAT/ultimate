import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { cleanEnv, temp } from '../helpers.ts'

const run = promisify(execFile)
const script = resolve('scripts/check-extension.ts')

it("type-checks a project's extensions against the clone, outside the clone", async () => {
  const project = await temp('ultimate-check-extension-project-')
  const extension = join(project, '.ultimate', 'extensions', 'hello')
  await mkdir(extension, { recursive: true })
  await writeFile(
    join(extension, 'web.tsx'),
    [
      "import { useState } from 'react'",
      "import { Button } from '@/components/ui/button'",
      'export function Hello() {',
      '  const [count, setCount] = useState(0)',
      '  return <Button onClick={() => setCount(count + 1)}>{count}</Button>',
      '}',
    ].join('\n'),
  )
  await writeFile(
    join(extension, 'server.ts'),
    "import { defineExtension } from '@earendil-works/pi-durable'\nexport default defineExtension({ name: 'hello' })\n",
  )
  const ok = await run(process.execPath, [script], { cwd: project, env: cleanEnv() })
  expect(ok.stdout).toContain('1 extension(s) type-check.')

  await writeFile(
    join(extension, 'server.ts'),
    "const count: number = 'one'\nexport default count\n",
  )
  const failed = await run(process.execPath, [script], { cwd: project, env: cleanEnv() }).then(
    () => undefined,
    (error: { code: number; stdout: string }) => error,
  )
  expect(failed?.code).toBe(1)
  expect(failed?.stdout).toContain(`${join(extension, 'server.ts')}(1,7): error TS2322`)
})
