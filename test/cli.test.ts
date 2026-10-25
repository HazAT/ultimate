import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { cliArgs } from '../bin/cli.ts'
import { removeTemp, temp } from './helpers.ts'

let home: string
const values = (args: string[], name: string) => args.filter((_, i) => args[i - 1] === name)
afterEach(() => removeTemp(home))

async function setup() {
  home = await temp()
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot, { recursive: true })
  // Pi's own home: a default model the harness would pick, and a personal SYSTEM.md the CLI must not load.
  vi.stubEnv('PI_CODING_AGENT_DIR', join(home, 'pi'))
  await mkdir(join(home, 'pi'), { recursive: true })
  await writeFile(
    join(home, 'pi/settings.json'),
    JSON.stringify({ defaultProvider: 'openai-codex', defaultModel: 'gpt-6.1-sol' }),
  )
  await writeFile(join(home, 'pi/SYSTEM.md'), 'Personal Pi system prompt.')
  await writeFile(join(projectRoot, 'AGENTS.md'), 'Project rule: keep it small.')
  await mkdir(join(home, '.ultimate/skills/mine'), { recursive: true })
  await writeFile(
    join(home, '.ultimate/skills/mine/SKILL.md'),
    '---\nname: mine\ndescription: A personal skill\n---\n',
  )
  await mkdir(join(home, '.agents/skills/shared/inspect'), { recursive: true })
  await writeFile(
    join(home, '.agents/skills/shared/inspect/SKILL.md'),
    '---\nname: inspect\ndescription: A shared personal skill\n---\n',
  )
  return { ultimateRoot: resolve('.'), projectRoot, userHome: home, home: join(home, 'state') }
}

it("gives Pi Ultimate's context, skills and Claude Code instead of Pi's personal ones", async () => {
  const host = await setup()
  const args = cliArgs(host, ['--model', 'anthropic/claude-opus-5-5', 'why is it broken'])
  const flag = (name: string, from = args) => values(from, name)
  expect(args).toEqual(
    expect.arrayContaining(['--no-context-files', '--no-skills', '--no-extensions']),
  )
  expect(flag('--skill')).toContain(join(home, '.ultimate/skills/mine/SKILL.md'))
  expect(flag('--skill')).toContain(join(home, '.agents/skills/shared/inspect/SKILL.md'))
  expect(flag('--extension')).toEqual([expect.stringMatching(/pi-claude-code\/src\/index\.ts$/)])
  expect(flag('--session-dir')).toEqual([join(host.home, 'cli-sessions')])
  // The harness's default model first, then the user's own arguments, so their --model wins and their message stays.
  expect(flag('--model')).toEqual(['openai-codex/gpt-6.1-sol', 'anthropic/claude-opus-5-5'])
  expect(args.slice(-3)).toEqual(['--model', 'anthropic/claude-opus-5-5', 'why is it broken'])
  expect(flag('--model', cliArgs(host, []))).toEqual(['openai-codex/gpt-6.1-sol'])

  // An explicit system prompt is what stops Pi discovering SYSTEM.md and APPEND_SYSTEM.md.
  const [prompt] = flag('--system-prompt')
  expect(args).not.toContain('--append-system-prompt')
  expect(prompt).not.toContain('Personal Pi system prompt.')
  expect(prompt).toContain("Ultimate's emergency terminal agent")
  expect(prompt).toContain('Project rule: keep it small.')
  expect(prompt).toContain(`Project home: ${host.home}: \`state.sqlite\``)
  expect(prompt).toContain('sqlite3 -readonly')
  // Mentioned only once the reset script exists in this checkout.
  expect(prompt.includes('`pnpm reset`')).toBe(
    'reset' in (await import('../package.json', { with: { type: 'json' } })).default.scripts,
  )
})
