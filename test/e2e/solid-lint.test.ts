import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { cleanEnv, sourceCopy, temp } from '../helpers.ts'

const run = promisify(execFile)

const solidMistakes = `/** @jsxImportSource @solidjs/web */
import { createSignal, createEffect, onMount } from 'solid-js'
import { createStore } from 'solid-js/store'
import { useState } from 'react'
import { readFileSync } from 'node:fs'
import { Switch } from '@ui-sdk/solid/switch'
import { Button } from '@/components/ui/button'
import { Twin } from './twin'

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
    <div className="x" role="listbox" on:click={() => setCount(count() + 1)}>
      {name}
      {x}
      {[1, 2].map((i) => <span>{i}</span>)}
      <Switch />
      <Button />
      <Twin />
      <span role={'switch'} />
      <button />
      {String(readFileSync)}
    </div>
  )
}
`

const reactMistakes = `import { useEffect, useState } from 'react'
import { render } from '@solidjs/web'
import { Bad } from './mistakes.solid'

export function Twin() {
  const [n, setN] = useState(0)
  useEffect(() => setN(n + 1), [])
  return <>{[1, 2].map((i) => <span>{i}</span>)}{String(render)}{String(Bad)}</>
}
`

const lineCommentPragma = `// @jsxImportSource @solidjs/web
export const LinePragma = () => <div class="x" />
`

const validRef = `/** @jsxImportSource @solidjs/web */
export function Field() {
  let input: HTMLInputElement | undefined
  return <input aria-label="Name" ref={input} />
}
`

const nodeImport = `/** @jsxImportSource @solidjs/web */
import { readFileSync } from 'node:fs'
export const size = readFileSync.length
`

interface Diagnostic {
  code: string
  severity: string
  filename: string
}

it('lints Solid files with Solid 2 strict rules as errors, and keeps React rules on React files', async () => {
  const source = await sourceCopy(await temp())
  const folder = join(source, 'extensions/solid-lint')
  const testFolder = join(source, 'test/web/solid-lint')
  const projectFolder = join(source, '.ultimate/extensions/solid-lint')
  for (const created of [folder, testFolder, projectFolder])
    await mkdir(created, { recursive: true })
  await writeFile(join(folder, 'mistakes.solid.tsx'), solidMistakes)
  await writeFile(join(folder, 'twin.tsx'), reactMistakes)
  await writeFile(join(folder, 'line-pragma.solid.tsx'), lineCommentPragma)
  await writeFile(join(folder, 'field.solid.tsx'), validRef)
  await writeFile(join(testFolder, 'untyped.solid.tsx'), 'export const a = 1\n')
  await writeFile(join(projectFolder, 'node.solid.tsx'), nodeImport)

  const lint = await run(
    'pnpm',
    [
      'exec',
      'vp',
      'lint',
      '--format',
      'json',
      relative(source, folder),
      relative(source, testFolder),
      relative(source, projectFolder),
    ],
    {
      cwd: source,
      env: cleanEnv(),
    },
  ).catch((error: { stdout: string }) => error)
  const diagnostics = (JSON.parse(lint.stdout) as { diagnostics: Diagnostic[] }).diagnostics
  const name = (file: string) =>
    [folder, testFolder, projectFolder]
      .map((root) => relative(root, resolve(source, file)))
      .find((path) => !path.startsWith('..'))
  const found = diagnostics.map((diagnostic) => `${name(diagnostic.filename)} ${diagnostic.code}`)

  expect(found).toEqual(
    expect.arrayContaining([
      'mistakes.solid.tsx solid(removed-api)',
      'mistakes.solid.tsx solid(no-single-arg-create-effect)',
      'mistakes.solid.tsx solid(no-store-mutation-outside-setter)',
      'mistakes.solid.tsx solid(no-destructure)',
      'mistakes.solid.tsx solid(components-return-once)',
      'mistakes.solid.tsx solid(prefer-for)',
      'mistakes.solid.tsx solid(no-react-specific-props)',
      'mistakes.solid.tsx solid(no-unknown-namespaces)',
      'mistakes.solid.tsx solid(reactivity)',
      'mistakes.solid.tsx ultimate(ui-framework-boundaries)',
      'mistakes.solid.tsx ultimate(ui-kit-roles)',
      'mistakes.solid.tsx jsx-a11y(control-has-associated-label)',
      'mistakes.solid.tsx eslint(no-restricted-imports)',
      'twin.tsx ultimate(ui-framework-boundaries)',
      'twin.tsx react-hooks(exhaustive-deps)',
      'twin.tsx react(jsx-key)',
      'line-pragma.solid.tsx ultimate(solid-jsx-pragma)',
      'line-pragma.solid.tsx ultimate(no-comments)',
      'untyped.solid.tsx ultimate(solid-jsx-pragma)',
      'node.solid.tsx eslint(no-restricted-imports)',
    ]),
  )
  expect(found.filter((line) => line.startsWith('field.solid.tsx'))).toEqual([])
  expect(found.filter((line) => line.startsWith('mistakes.solid.tsx react('))).toEqual([])
  expect(found.filter((line) => line.startsWith('twin.tsx solid('))).toEqual([])
  expect(found.filter((line) => line.startsWith('mistakes.solid.tsx react-hooks('))).toEqual([])
  expect(new Set(diagnostics.map((diagnostic) => diagnostic.severity))).toEqual(new Set(['error']))
  expect(
    found.filter((line) => line === 'mistakes.solid.tsx ultimate(ui-framework-boundaries)'),
  ).toHaveLength(4)
  expect(
    found.filter((line) => line === 'twin.tsx ultimate(ui-framework-boundaries)'),
  ).toHaveLength(2)
  expect(found.filter((line) => line.endsWith('ultimate(ui-kit-roles)'))).toHaveLength(3)
})
