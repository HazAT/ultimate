import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { context } from '../server/harness.ts'
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
            } as Parameters<typeof section.render>[0],
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
    // The search programs are the ones that exist here: a missing one exits 127 with no output, which reads as an empty result.
    expect(withoutSelf.tools).toContain('searches (`grep -rn`, `find`, `ls`)')
    expect(withoutSelf.tools).not.toMatch(/\brg\b/)
    expect(withoutSelf.tools).toContain('exits 127 with no output')

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
    const skills = vi.spyOn(server.host, 'skills')
    for (const useEnv of [true, false]) {
      const isolated = await render(checkout, useEnv)
      expect(isolated.cwd).toBe(checkout)
      expect(isolated.project_context).toContain('Isolated project instructions.')
      expect(isolated.project_context).toContain('Ultimate personal instructions.')
      expect(isolated.project_context).not.toContain('Pi personal instructions.')
      expect(isolated.skills).toContain('ultimate-only')
      expect(isolated.skills).not.toContain('pi-only')
      expect(skills).toHaveBeenLastCalledWith(checkout)
    }
    skills.mockRestore()
  } finally {
    await server.close()
    await removeTemp(home)
  }
})
