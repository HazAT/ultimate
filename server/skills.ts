import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useProjectSetup } from '../lib/project-setup.ts'
import { loadSkills, stripFrontmatter } from '@earendil-works/pi-coding-agent'
import type { Skill } from '@earendil-works/pi-coding-agent'

export type SkillScope = 'clone' | 'user' | 'project'

export type ScopedSkill = Skill & { scope: SkillScope; overrides: string[] }

export function projectSkills(
  host: { ultimateRoot: string; projectRoot: string; userHome: string },
  cwd = host.projectRoot,
) {
  const trusted = useProjectSetup(host.projectRoot, host.userHome)
  const layersInOverrideOrder: [string, SkillScope][] = [
    [join(host.ultimateRoot, 'skills'), 'clone'],
    [join(cwd, '.pi/skills'), 'project'],
    [join(host.userHome, '.ultimate/skills'), 'user'],
    ...(trusted
      ? ([
          [join(host.projectRoot, '.agents/skills'), 'project'],
          [join(host.projectRoot, '.ultimate/skills'), 'project'],
        ] as [string, SkillScope][])
      : []),
  ]
  const agentDir = join(host.userHome, '.ultimate')
  const winnersInScopeOrder = new Map<string, ScopedSkill>()
  const diagnostics = []
  for (const [path, scope] of layersInOverrideOrder.filter(([folder]) => existsSync(folder))) {
    const loaded = loadSkills({ cwd, agentDir, skillPaths: [path], includeDefaults: false })
    diagnostics.push(...loaded.diagnostics)
    for (const skill of loaded.skills) {
      const earlier = winnersInScopeOrder.get(skill.name)
      winnersInScopeOrder.delete(skill.name)
      winnersInScopeOrder.set(skill.name, {
        ...skill,
        scope,
        overrides: earlier ? [...earlier.overrides, earlier.filePath] : [],
      })
    }
  }
  return { skills: [...winnersInScopeOrder.values()], diagnostics }
}

export function expandSkillCommand(text: string, skills: readonly Skill[]) {
  // Pi upstream: @earendil-works/pi-coding-agent@1.6.0 src/core/agent-session.ts _expandSkillCommand — copied block format. Drop when Pi exports the expansion.
  const match = /^\/skill:(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  const skill = match && skills.find((candidate) => candidate.name === match[1])
  if (!match || !skill) return text
  const body = stripFrontmatter(readFileSync(skill.filePath, 'utf8')).trim()
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`
  const args = match[2]?.trim()
  return args ? `${block}\n\n${args}` : block
}
