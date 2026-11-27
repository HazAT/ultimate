import { expect, it } from 'vitest'
import { compareUrl } from '../lib/compare.shared.ts'
import { projectKey } from '../lib/project-identity.ts'

it('opens a GitHub compare range on DiffsHub', () => {
  expect(compareUrl('github.com/hazat/ultimate', 'aaa', 'bbb')).toBe(
    'https://diffshub.com/hazat/ultimate/compare/aaa...bbb',
  )
  // The key comes straight from origin, SSH or HTTPS alike.
  const key = projectKey('git@github.com:HazAT/ultimate.git')!
  expect(compareUrl(key, '1234567', '89abcde')).toBe(
    'https://diffshub.com/hazat/ultimate/compare/1234567...89abcde',
  )
})
