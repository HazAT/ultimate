import { expect, it, vi } from 'vitest'
import type { SystemInfo } from '../../shared/protocol.ts'
import { projectName, projectTitle } from '../../web/src/app/titlebar.tsx'

// The rest of the title bar reaches the page and its server; the project's names use none of it.
vi.mock('../../web/src/sdk/hooks.ts', () => ({}))
vi.mock('../../web/src/sdk/actions.ts', () => ({}))
vi.mock('../../web/src/app/palette.tsx', () => ({}))
vi.mock('../../web/src/app/primitives.tsx', () => ({}))

const system = (root: string) =>
  ({
    machine: { home: '/home/me' },
    project: { root, name: root.split('/').at(-1) },
    persistence: { path: '/home/me/.ultimate/projects/atlas-1a2b3c4d/state.db' },
  }) as unknown as SystemInfo
const main = system('/home/me/code/atlas-web')
const branch = system('/home/me/.ultimate/projects/atlas-web-1a2b3c4d/worktrees/42')

it("names the project by its label in the tab title and the chip, its folder's without one", () => {
  expect([projectTitle(main), projectName(main)]).toEqual(['~/code/atlas-web', 'atlas-web'])
  expect([projectTitle(main, 'Atlas'), projectName(main, 'Atlas')]).toEqual(['Atlas', 'Atlas'])
  expect([projectTitle(branch, 'Atlas'), projectName(branch, 'Atlas')]).toEqual([
    'Atlas #42',
    'Atlas #42',
  ])
  // A label shows even when the folder is Ultimate's own name, which the chip otherwise leaves out.
  expect(projectName(system('/home/me/ultimate'), 'Atlas')).toBe('Atlas')
})
