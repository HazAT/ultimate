import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { context } from '../server/harness.ts'
import { Profile } from '../extensions/subagents/api.ts'
import { fauxServer, temp, removeTemp, until } from './helpers.ts'

it('renders only enabled guidance, lists off building blocks, and adds self guidance live', async () => {
  const home = await temp()
  vi.stubEnv('PI_CODING_AGENT_DIR', join(home, 'pi'))
  // Pi's personal instructions and skills stay with Pi; Ultimate's come from ~/.ultimate.
  for (const [dir, owner] of [
    ['pi', 'Pi'],
    ['.ultimate', 'Ultimate'],
  ]) {
    const skill = join(home, dir, 'skills', `${owner.toLowerCase()}-only`)
    await mkdir(skill, { recursive: true })
    await writeFile(join(home, dir, 'AGENTS.md'), `${owner} personal instructions.`)
    await writeFile(
      join(skill, 'SKILL.md'),
      `---\nname: ${owner.toLowerCase()}-only\ndescription: ${owner} skill\n---\n`,
    )
  }
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  const settings = join(projectRoot, '.ultimate/settings.json')
  await writeFile(settings, JSON.stringify({ extensions: { disable: ['self'] } }))
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  try {
    async function render(cwd = projectRoot, useEnv = true) {
      const agent = await server.root.agent(context)
      const sections: Record<string, string> = {}
      for (const extension of server.host.registry.snapshot().installed()) {
        if (!['prompt', 'self'].includes(extension.name)) continue
        for (const section of extension.sections ?? []) {
          const value = await section.render(
            {
              conversationId: server.root.id,
              agent: { ...agent, cwd },
              env: useEnv ? { cwd } : undefined,
              read: server.harness,
            } as unknown as Parameters<typeof section.render>[0],
            context,
          )
          if (value) sections[section.key] = value
        }
      }
      return sections
    }
    const withoutSelf = await render()
    expect(withoutSelf.self).toBeUndefined()
    expect(withoutSelf.building_blocks).toContain('- self:')

    await writeFile(settings, '{}')
    server.vite.watcher.emit('change', settings)
    await until(() => !!server.host.registry.snapshot().extension('self'))
    const withSelf = await render()
    expect(withSelf.self).toBeDefined()
    // Only the default-off built-ins are left to list.
    expect(withSelf.building_blocks).not.toContain('- self:')
    expect(withSelf.building_blocks).toContain('- sounds:')

    const checkout = join(home, 'isolated-work')
    await mkdir(checkout)
    await writeFile(join(checkout, 'AGENTS.md'), 'Isolated project instructions.')
    const skillsCall = vi.spyOn(server.host, 'skills')
    for (const useEnv of [true, false]) {
      const isolated = await render(checkout, useEnv)
      expect(isolated.environment).toContain(`Work checkout (effective cwd): ${checkout}`)
      expect(isolated.project_context).toContain('Isolated project instructions.')
      expect(isolated.project_context).toContain('Ultimate personal instructions.')
      expect(isolated.project_context).not.toContain('Pi personal instructions.')
      expect(isolated.skills).toContain('ultimate-only')
      expect(isolated.skills).not.toContain('pi-only')
      expect(skillsCall).toHaveBeenLastCalledWith(checkout)
    }
    skillsCall.mockRestore()

    const second = join(home, '.ultimate/skills/second')
    await mkdir(second, { recursive: true })
    await writeFile(join(second, 'SKILL.md'), '---\nname: second\ndescription: Second\n---\n')
    await mkdir(join(home, '.ultimate/agents'), { recursive: true })
    const agent = (name: string, skills: string, family = 'default') =>
      writeFile(
        join(home, `.ultimate/agents/${name}.md`),
        `---\nname: ${name}\ndescription: d\nfamily: ${family}\nskills: ${skills}\n---\n\nBody.\n`,
      )
    await agent('limited', '[ultimate-only]')
    await agent('none', '[]')
    const labelled = async (label: string) => {
      await server.harness.commit(async (tx) => {
        ;(await tx.doc(Profile, server.root.id)).definition = label
      }, context)
      return (await render()).skills
    }
    expect(await labelled('worker')).toContain('second')
    const limited = await labelled('limited')
    expect(limited).toContain('ultimate-only')
    expect(limited).not.toContain('second')
    expect(await labelled('none')).toBeUndefined()

    await agent('lookup', '[]', 'tiny')
    await server.harness.commit(async (tx) => {
      ;(await tx.doc(Profile, server.root.id)).definition = 'lookup'
    }, context)
    expect((await render(checkout)).project_context).toBe(
      `Project instructions, to read when your task needs them: ${join(home, '.ultimate/AGENTS.md')}, ${join(checkout, 'AGENTS.md')}`,
    )
  } finally {
    await server.close()
    await removeTemp(home)
  }
})
