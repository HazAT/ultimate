import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { loadSkills, ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { afterEach, expect, it } from 'vitest'
import { expandSkillCommand, projectSkills } from '../server/skills.ts'
import { skillInfo } from '../server/system.ts'
import { removeTemp, temp } from './helpers.ts'

let home: string
afterEach(() => removeTemp(home))

async function skill(path: string, frontmatter: string, body = 'Do the thing.') {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `---\n${frontmatter}\n---\n${body}\n`)
}

async function setup() {
  home = await temp()
  const host = {
    ultimateRoot: join(home, 'clone'),
    projectRoot: join(home, 'project'),
    userHome: join(home, 'user'),
  }
  await mkdir(host.projectRoot, { recursive: true })
  await skill(
    join(host.ultimateRoot, 'skills/ship/SKILL.md'),
    'name: ship\ndescription: Clone ship',
  )
  await skill(
    join(host.userHome, '.ultimate/skills/ship/SKILL.md'),
    'name: ship\ndescription: User ship',
  )
  // The personal Agent Skills folder belongs to other agents and is never read.
  await skill(
    join(host.userHome, '.agents/skills/shared/SKILL.md'),
    'name: shared\ndescription: Personal Agent Skills folder',
  )
  await skill(
    join(host.projectRoot, '.agents/skills/team/SKILL.md'),
    'name: team\ndescription: Team skill\ndisable-model-invocation: true',
  )
  await skill(join(host.projectRoot, '.ultimate/skills/broken/SKILL.md'), 'name: broken')
  return host
}

it('loads every scope, lets later scopes override and keeps Pi diagnostics', async () => {
  const host = await setup()
  const untrusted = skillInfo(projectSkills(host))
  // The project's .agents and .ultimate skills wait for the project to be trusted.
  expect(untrusted.skills.map((s) => [s.name, s.scope, s.description])).toEqual([
    ['ship', 'user', 'User ship'],
  ])
  expect(untrusted.skills[0]?.overrides).toEqual([join(host.ultimateRoot, 'skills/ship/SKILL.md')])
  expect(untrusted.skillDiagnostics).toEqual([])

  new ProjectTrustStore(join(host.userHome, '.ultimate')).set(host.projectRoot, true)
  const trusted = skillInfo(projectSkills(host))
  expect(trusted.skills.find((s) => s.name === 'team')).toMatchObject({
    scope: 'project',
    manual: true,
  })
  expect(trusted.skills.some((s) => s.name === 'broken' || s.name === 'shared')).toBe(false)
  expect(trusted.skillDiagnostics).toEqual([
    {
      type: 'warning',
      message: 'description is required',
      path: join(host.projectRoot, '.ultimate/skills/broken/SKILL.md'),
    },
  ])
})

// Two project skills once had an unquoted `: ` in their description, so YAML refused them and they never loaded.
it.each(['skills', '.ultimate/skills'])(
  'every skill shipped in %s loads without diagnostics',
  async (folder) => {
    const path = resolve(folder)
    const loaded = loadSkills({
      cwd: resolve('.'),
      agentDir: path,
      skillPaths: [path],
      includeDefaults: false,
    })
    expect(loaded.diagnostics).toEqual([])
    expect(loaded.skills.map((s) => s.name).toSorted()).toEqual((await readdir(path)).toSorted())
  },
)

it('expands /skill:name args as Pi does and leaves anything else alone', async () => {
  const host = await setup()
  const { skills } = projectSkills(host)
  const path = join(host.userHome, '.ultimate/skills/ship/SKILL.md')
  expect(expandSkillCommand('/skill:ship  to staging ', skills)).toBe(
    `<skill name="ship" location="${path}">\nReferences are relative to ${dirname(path)}.\n\nDo the thing.\n</skill>\n\nto staging`,
  )
  expect(expandSkillCommand('/skill:ship', skills)).toMatch(/<\/skill>$/)
  expect(expandSkillCommand('/skill:unknown go', skills)).toBe('/skill:unknown go')
  expect(expandSkillCommand('please /skill:ship', skills)).toBe('please /skill:ship')
})
