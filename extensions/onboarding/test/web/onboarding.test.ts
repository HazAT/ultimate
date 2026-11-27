import { expect, it } from 'vitest'
import { extensionChoices, extensionOptions, settledChoice } from '../../choices.web.ts'

it('settles a project card once the project setup is decided elsewhere, keeping an answer given on it', () => {
  expect(settledChoice('project', undefined, null)).toBeUndefined()
  expect(settledChoice('project', undefined, true)).toBe('Using project setup')
  expect(settledChoice('project', undefined, false)).toBe('Keeping global setup')
  expect(settledChoice('project', 'Using project setup', false)).toBe('Using project setup')
  // Other cards have no standing decision: only their own answer settles them.
  expect(settledChoice('git', undefined, true)).toBeUndefined()
})

it('checks Jev and web search until the user turns them off, and other extras only once enabled', () => {
  const checked = (user: { enable: string[]; disable: string[] }, changed = {}) =>
    Object.fromEntries(extensionOptions(user, changed).map((o) => [o.key, o.checked]))
  expect(checked({ enable: [], disable: [] })).toEqual({
    jev: true,
    parallel: true,
    sounds: false,
    tailscale: false,
    health: false,
    cloud: false,
  })
  expect(checked({ enable: ['sounds'], disable: ['phase'] })).toMatchObject({
    jev: false,
    sounds: true,
  })
  expect(checked({ enable: ['sounds'], disable: [] }, { sounds: false })).toMatchObject({
    sounds: false,
  })
  const choices = extensionChoices(extensionOptions({ enable: [], disable: [] }, { cloud: true }))
  expect(choices).toMatchObject({ classify: true, phase: true, recall: true, parallel: true })
  expect(choices).toMatchObject({ cloud: true, sounds: false })
})
