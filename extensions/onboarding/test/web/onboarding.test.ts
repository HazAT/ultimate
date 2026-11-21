import { expect, it } from 'vitest'
import { extensionOptions, settledChoice, switchScope } from '../../choices.ts'

it('saves extension switches to user settings unless the user picks this project', () => {
  expect(switchScope(true)).toBe('user')
  expect(switchScope(false)).toBe('user')
  expect(switchScope(false, 'project')).toBe('user')
  expect(switchScope(true, 'project')).toBe('project')
})

it('settles a project card once the project setup is decided elsewhere, keeping an answer given on it', () => {
  expect(settledChoice('project', undefined, null)).toBeUndefined()
  expect(settledChoice('project', undefined, true)).toBe('Using project setup')
  expect(settledChoice('project', undefined, false)).toBe('Keeping global setup')
  expect(settledChoice('project', 'Using project setup', false)).toBe('Using project setup')
  // Other cards have no standing decision: only their own answer settles them.
  expect(settledChoice('git', undefined, true)).toBeUndefined()
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
