import { afterEach, expect, it, vi } from 'vitest'
import { exec } from '../lib/exec.ts'
import { readGithubRepo } from '../lib/project-identity.ts'

vi.mock('../lib/exec.ts', () => ({ exec: vi.fn<typeof exec>() }))

afterEach(() => {
  vi.resetAllMocks()
})

it.each(['public', 'private'] as const)('reads a %s repository', async (visibility) => {
  vi.mocked(exec).mockResolvedValue({
    stdout: JSON.stringify({ nameWithOwner: 'Owner/Repo', visibility: visibility.toUpperCase() }),
    stderr: '',
  })
  expect(await readGithubRepo('github.com/owner/repo')).toEqual({
    key: 'github.com/owner/repo',
    name: 'Owner/Repo',
    url: 'https://github.com/owner/repo',
    visibility,
  })
})

it('falls back to the key when gh fails', async () => {
  vi.mocked(exec).mockRejectedValue(new Error('gh: command not found'))
  expect(await readGithubRepo('github.com/owner/repo')).toEqual({
    key: 'github.com/owner/repo',
    name: 'owner/repo',
    url: 'https://github.com/owner/repo',
  })
})
