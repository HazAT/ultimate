import { expect, it } from 'vitest'
import { extensionOptions, switchScope } from '../../choices.tsx'

it('saves extension switches to user settings unless the user picks this project', () => {
  expect(switchScope(true)).toBe('user')
  expect(switchScope(false)).toBe('user')
  expect(switchScope(false, 'project')).toBe('user')
  expect(switchScope(true, 'project')).toBe('project')
})

it('offers only the optional extensions, unchecked until the user enables them', () => {
  const fresh = extensionOptions({ enable: [], disable: [] }, {})
  expect(fresh.map(({ name, checked }) => ({ name, checked }))).toEqual(
    ['sounds', 'tailscale', 'parallel', 'health', 'cloud', 'classify', 'phase'].map((name) => ({
      name,
      checked: false,
    })),
  )
  expect(fresh.find((option) => option.name === 'phase')).toMatchObject({ needs: 'classify' })
  expect(
    extensionOptions({ enable: ['sounds'], disable: [] }, {}).find(
      (option) => option.name === 'sounds',
    ),
  ).toMatchObject({ checked: true })
  expect(
    extensionOptions({ enable: ['sounds'], disable: [] }, { sounds: false }).find(
      (option) => option.name === 'sounds',
    ),
  ).toMatchObject({ checked: false })
})
