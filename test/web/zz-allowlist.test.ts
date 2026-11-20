import { defaultRehypePlugins } from 'streamdown'
import { expect, it, vi } from 'vitest'

const seen: Record<string, unknown> = {}
vi.mock('rehype-sanitize', async (original) => {
  const real = (await original()) as typeof import('rehype-sanitize')
  return {
    ...real,
    default: (options: unknown) => {
      seen.sanitize = options
      return real.default(options as never)
    },
  }
})
vi.mock('rehype-harden', async (original) => {
  const real = (await original()) as typeof import('rehype-harden')
  return {
    ...real,
    harden: (options: never) => {
      seen.harden = options
      return real.harden(options)
    },
  }
})

it('passes streamdown 2.7.0 exactly its sanitize schema and harden options', async () => {
  const { parse } = await import('../../web/src/components/markdown/parse.ts')
  parse('<b>x</b>')
  const [, schema] = defaultRehypePlugins.sanitize as [unknown, unknown]
  const [, hardening] = defaultRehypePlugins.harden as [unknown, unknown]
  console.log(JSON.stringify(seen.sanitize) === JSON.stringify(schema), JSON.stringify(seen.harden) === JSON.stringify(hardening))
  expect(seen.sanitize).toStrictEqual(schema)
  expect(seen.harden).toStrictEqual(hardening)
})
