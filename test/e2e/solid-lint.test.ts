import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { cleanEnv, temp } from '../helpers.ts'

const run = promisify(execFile)

const mistakes = `import { createSignal, createEffect, onMount } from 'solid-js'
import { createStore } from 'solid-js/store'
import { useState } from 'react'
import { Switch } from '@ui-sdk/solid/switch'

export function Bad({ name }: { name: string }) {
  const [count, setCount] = createSignal(0)
  const [x] = useState(0)
  createEffect(() => {
    document.title = String(count())
  })
  onMount(() => setCount(1))
  const [s] = createStore({ a: 1 })
  s.a = 2
  if (count() > 1) return null
  return (
    <div className="x" role="listbox" onClick={() => setCount(count() + 1)}>
      {name}
      {x}
      {[1, 2].map((i) => <span>{i}</span>)}
      <Switch />
      <button />
    </div>
  )
}
`

it('lints Solid files with Solid 2 strict rules, accessibility and our framework boundaries', async () => {
  const folder = await temp('solid-lint-', resolve('extensions'))
  await mkdir(folder, { recursive: true })
  const solidFile = join(folder, 'mistakes.solid.tsx')
  const reactFile = join(folder, 'island.tsx')
  await writeFile(solidFile, mistakes)
  await writeFile(reactFile, "import { render } from '@solidjs/web'\nexport const mount = render\n")

  const lint = await run(
    'pnpm',
    ['exec', 'vp', 'lint', '--format', 'json', relative('.', folder)],
    {
      env: cleanEnv(),
    },
  ).catch((error: { stdout: string }) => error)
  const found = (
    JSON.parse(lint.stdout) as { diagnostics: { code: string; filename: string }[] }
  ).diagnostics.map((diagnostic) => `${relative(folder, diagnostic.filename)} ${diagnostic.code}`)

  expect(found).toEqual(
    expect.arrayContaining([
      'mistakes.solid.tsx solid(removed-api)',
      'mistakes.solid.tsx solid(no-single-arg-create-effect)',
      'mistakes.solid.tsx solid(no-store-mutation-outside-setter)',
      'mistakes.solid.tsx solid(no-destructure)',
      'mistakes.solid.tsx solid(components-return-once)',
      'mistakes.solid.tsx solid(prefer-for)',
      'mistakes.solid.tsx solid(no-react-specific-props)',
      'mistakes.solid.tsx solid(reactivity)',
      'mistakes.solid.tsx ultimate(ui-framework-boundaries)',
      'mistakes.solid.tsx ultimate(ui-kit-roles)',
      'mistakes.solid.tsx jsx-a11y(control-has-associated-label)',
      'island.tsx ultimate(ui-framework-boundaries)',
    ]),
  )
  expect(found.filter((line) => line.includes('react('))).toEqual([])
})
