import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ModelRuntime, ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { afterEach, expect, it } from 'vitest'
import { projectsSection } from '../remote.ts'
import { projects, writeProject } from '../../../server/project.ts'
import { removeTemp, temp } from '../../../test/helpers.ts'

const directories: string[] = []
afterEach(async () => {
  for (const path of directories.splice(0)) await removeTemp(path)
})
const directory = async () => {
  const path = await temp('ultimate-projects-')
  directories.push(path)
  return path
}
const resident = (name: string) =>
  `---\nname: ${name}\ndescription: ${name} agent\nresident: true\n---\nInstructions\n`

it('lists other projects with their standing agents, and a new one on the next render', async () => {
  const [repo, userHome, life, here] = await Promise.all([
    directory(),
    directory(),
    directory(),
    directory(),
  ])
  await mkdir(join(repo, 'agents'))
  await writeFile(join(repo, 'agents/ultimate.md'), resident('ultimate'))
  const homes = join(userHome, '.ultimate/projects')
  await mkdir(join(homes, 'life'), { recursive: true })
  await mkdir(join(homes, 'here'), { recursive: true })
  await writeProject(join(homes, 'life'), life, 'Life')
  await writeProject(join(homes, 'here'), here, 'Here')
  new ProjectTrustStore(join(userHome, '.ultimate')).set(life, true)
  const resources = new Map<string, unknown>()
  const host = {
    projects: () => projects(userHome, join(homes, 'here')),
    ultimateRoot: repo,
    projectRoot: here,
    userHome,
    modelRuntime: await ModelRuntime.create(),
    resource: <T>(key: string, create: () => T) =>
      (resources.get(key) ?? resources.set(key, create()).get(key)) as T,
  }
  expect(await projectsSection(host)).toContain('\n- Life')
  expect(await projectsSection(host)).not.toContain('Here')

  await mkdir(join(life, '.ultimate/agents'), { recursive: true })
  await writeFile(join(life, '.ultimate/agents/notes.md'), resident('notes'))
  expect(await projectsSection(host)).toContain('\n- Life: @notes')
})
