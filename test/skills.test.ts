import { mkdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
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
  // Shared personal skills are available without trusting a project.
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
    ['shared', 'user', 'Personal Agent Skills folder'],
    ['ship', 'user', 'User ship'],
  ])
  expect(untrusted.skills.find((s) => s.name === 'ship')?.overrides).toEqual([
    join(host.ultimateRoot, 'skills/ship/SKILL.md'),
  ])
  expect(untrusted.skillDiagnostics).toEqual([])

  new ProjectTrustStore(join(host.userHome, '.ultimate')).set(host.projectRoot, true)
  const trusted = skillInfo(projectSkills(host))
  expect(trusted.skills.find((s) => s.name === 'team')).toMatchObject({
    scope: 'project',
    manual: true,
  })
  expect(trusted.skills.some((s) => s.name === 'broken')).toBe(false)
  expect(trusted.skillDiagnostics).toEqual([
    {
      type: 'warning',
      message: 'description is required',
      path: join(host.projectRoot, '.ultimate/skills/broken/SKILL.md'),
    },
  ])
})

it('loads nested shared packages and keeps Ultimate and trusted project precedence', async () => {
  const host = await setup()
  const shared = join(host.userHome, '.agents/skills/shared/ship/SKILL.md')
  const nested = join(host.userHome, '.agents/skills/methods/inspect/SKILL.md')
  // A collection is a container, not itself a skill root.
  await skill(shared, 'name: ship\ndescription: Shared ship')
  await skill(
    nested,
    'name: inspect\ndescription: Inspect shared resources',
    'Read references/check.md.',
  )
  // Remove the collection's entry file so Pi recurses into its packages.
  await unlink(join(host.userHome, '.agents/skills/shared/SKILL.md'))
  const user = projectSkills(host)
  expect(user.skills.find((s) => s.name === 'ship')).toMatchObject({
    description: 'User ship',
    scope: 'user',
    overrides: [join(host.ultimateRoot, 'skills/ship/SKILL.md'), shared],
  })
  expect(user.skills.find((s) => s.name === 'inspect')).toMatchObject({
    scope: 'user',
    filePath: nested,
    baseDir: dirname(nested),
  })
  expect(expandSkillCommand('/skill:inspect', user.skills)).toContain(
    `References are relative to ${dirname(nested)}.`,
  )

  const project = join(host.projectRoot, '.agents/skills/ship/SKILL.md')
  await skill(project, 'name: ship\ndescription: Project ship')
  new ProjectTrustStore(join(host.userHome, '.ultimate')).set(host.projectRoot, false)
  expect(projectSkills(host).skills.find((s) => s.name === 'ship')?.description).toBe('User ship')
  new ProjectTrustStore(join(host.userHome, '.ultimate')).set(host.projectRoot, true)
  expect(projectSkills(host).skills.find((s) => s.name === 'ship')).toMatchObject({
    description: 'Project ship',
    scope: 'project',
    filePath: project,
    overrides: [
      join(host.ultimateRoot, 'skills/ship/SKILL.md'),
      shared,
      join(host.userHome, '.ultimate/skills/ship/SKILL.md'),
    ],
  })
})

it('keeps Pi diagnostics, symlink handling and package boundaries for personal shared skills', async () => {
  const host = await setup()
  const root = join(host.userHome, '.agents/skills')
  await skill(join(root, 'broken/SKILL.md'), 'name: broken')
  await skill(join(root, 'bad-yaml/SKILL.md'), 'name: [')
  await skill(
    join(root, 'manual/SKILL.md'),
    'name: manual\ndescription: Manual only\ndisable-model-invocation: true',
  )
  await skill(
    join(root, 'shared/hidden/SKILL.md'),
    'name: hidden\ndescription: Nested inside a package',
  )
  await symlink(join(root, 'shared'), join(root, 'alias'), 'dir')
  await symlink(join(root, 'missing'), join(root, 'dangling'), 'dir')
  const result = skillInfo(projectSkills(host))
  expect(result.skills.filter((s) => s.name === 'shared')).toHaveLength(1)
  expect(result.skills.some((s) => ['broken', 'bad-yaml', 'hidden'].includes(s.name))).toBe(false)
  expect(result.skills.find((s) => s.name === 'manual')).toMatchObject({
    scope: 'user',
    manual: true,
  })
  expect(result.skillDiagnostics).toEqual(
    expect.arrayContaining([
      { type: 'warning', path: join(root, 'broken/SKILL.md'), message: 'description is required' },
      { type: 'warning', path: join(root, 'bad-yaml/SKILL.md'), message: expect.any(String) },
    ]),
  )
})

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
