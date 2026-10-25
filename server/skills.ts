import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useProjectSetup } from './project-setup.ts'
import { loadSkills, stripFrontmatter } from '@earendil-works/pi-coding-agent'
import type { Skill } from '@earendil-works/pi-coding-agent'

export type SkillScope = 'clone' | 'user' | 'project'

/** A loaded skill with where it came from, and the paths of same-named skills it overrides in earlier scopes. */
export type ScopedSkill = Skill & { scope: SkillScope; overrides: string[] }

/**
 * Skills from the clone, the project's `.pi/skills`, `~/.agents/skills`, `~/.ultimate/skills` and, once the project is trusted,
 * `<project>/.ultimate/skills`. A later scope overrides an earlier skill of the same name (Pi keeps the first;
 * Ultimate lets the project override the user and the user the clone). Diagnostics are Pi's, per file.
 */
export function projectSkills(
  host: { ultimateRoot: string; projectRoot: string; userHome: string },
  cwd = host.projectRoot,
) {
  // Shared Agent Skills load before Ultimate-specific skills in each scope; project roots wait for trust.
  const trusted = useProjectSetup(host.projectRoot, host.userHome)
  const layers: [string, SkillScope][] = [
    [join(host.ultimateRoot, 'skills'), 'clone'],
    [join(cwd, '.pi/skills'), 'project'],
    [join(host.userHome, '.agents/skills'), 'user'],
    [join(host.userHome, '.ultimate/skills'), 'user'],
    ...(trusted
      ? ([
          [join(host.projectRoot, '.agents/skills'), 'project'],
          [join(host.projectRoot, '.ultimate/skills'), 'project'],
        ] as [string, SkillScope][])
      : []),
  ]
  const agentDir = join(host.userHome, '.ultimate')
  const byName = new Map<string, ScopedSkill>()
  const diagnostics = []
  // Most folders don't exist; Pi warns about each missing one, which says nothing here.
  for (const [path, scope] of layers.filter(([folder]) => existsSync(folder))) {
    const loaded = loadSkills({ cwd, agentDir, skillPaths: [path], includeDefaults: false })
    diagnostics.push(...loaded.diagnostics)
    for (const skill of loaded.skills) {
      const earlier = byName.get(skill.name)
      // Map order is first insertion: delete so the winner lists where its own scope puts it.
      byName.delete(skill.name)
      byName.set(skill.name, {
        ...skill,
        scope,
        overrides: earlier ? [...earlier.overrides, earlier.filePath] : [],
      })
    }
  }
  return { skills: [...byName.values()], diagnostics }
}

/**
 * `/skill:name args` as Pi's AgentSession expands it: the skill's body in a `<skill>` block, then the arguments as the
 * request. Any other text, or an unknown skill, comes back as it was.
 */
export function expandSkillCommand(text: string, skills: readonly Skill[]) {
  // Pi upstream: @earendil-works/pi-coding-agent@1.4.0 src/core/agent-session.ts _expandSkillCommand — copied block format. Drop when Pi exports the expansion.
  const match = /^\/skill:(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  const skill = match && skills.find((candidate) => candidate.name === match[1])
  if (!match || !skill) return text
  const body = stripFrontmatter(readFileSync(skill.filePath, 'utf8')).trim()
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`
  const args = match[2]?.trim()
  return args ? `${block}\n\n${args}` : block
}
