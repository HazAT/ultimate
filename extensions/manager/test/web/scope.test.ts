import { expect, it } from 'vitest'
import { switchScope } from '../../scope.web.ts'

it('saves extension switches to user settings unless the user picks this project', () => {
  expect(switchScope(true)).toBe('user')
  expect(switchScope(false)).toBe('user')
  expect(switchScope(false, 'project')).toBe('user')
  expect(switchScope(true, 'project')).toBe('project')
})
