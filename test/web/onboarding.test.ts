import { expect, it } from 'vitest'
import { extensionOptions, switchScope } from '../../extensions/onboarding/choices.tsx'

it('saves extension switches to user settings unless the user picks this project', () => {
  expect(switchScope(true)).toBe('user')
  expect(switchScope(false)).toBe('user')
  expect(switchScope(false, 'project')).toBe('user')
  expect(switchScope(true, 'project')).toBe('project')
})

const core = ['subagents', 'messages', 'lineage', 'onboarding', 'documents']

it('keeps every core-tier extension checked and locked, even over saved or pending disables', () => {
  const changed = Object.fromEntries(core.map((name) => [name, false]))
  const options = extensionOptions(
    { enable: [], disable: [...core, 'plan'] },
    { ...changed, info: false },
    core,
  )
  expect(options.filter((entry) => entry.required).map((entry) => entry.name)).toEqual([
    'subagents',
    'messages',
    'lineage',
    'onboarding',
    'documents',
  ])
  for (const name of core) {
    expect(options.find((entry) => entry.name === name)).toMatchObject({
      checked: true,
      required: true,
      hint: 'core, always on',
    })
  }
  expect(options.find((entry) => entry.name === 'plan')).toMatchObject({
    checked: false,
    required: false,
  })
  expect(options.find((entry) => entry.name === 'info')).toMatchObject({
    checked: false,
    required: false,
  })
  expect(
    extensionOptions({ enable: [], disable: ['plan'] }, { plan: true }, core).find(
      (entry) => entry.name === 'plan',
    ),
  ).toMatchObject({ checked: true, required: false })
})

it('leaves default-off built-ins unchecked until the user enables them, with what each needs', () => {
  const fresh = extensionOptions({ enable: [], disable: [] }, {}, core)
  const off = ['parallel', 'exa', 'cloud', 'tailscale', 'health', 'classify', 'phase', 'sounds']
  expect(
    fresh
      .filter((option) => off.includes(option.name))
      .map(({ name, checked, hint }) => ({
        name,
        checked,
        hinted: !!hint,
      })),
  ).toEqual(off.map((name) => ({ name, checked: false, hinted: true })))
  expect(fresh.find((option) => option.name === 'plan')).toMatchObject({ checked: true })
  // The updater is on for everyone: checked, unless the user's settings disable it.
  expect(fresh.find((option) => option.name === 'update')).toMatchObject({ checked: true })
  expect(
    extensionOptions({ enable: [], disable: ['update'] }, {}, core).find(
      (option) => option.name === 'update',
    ),
  ).toMatchObject({ checked: false })
  expect(
    extensionOptions({ enable: ['sounds'], disable: [] }, {}, core).find(
      (option) => option.name === 'sounds',
    ),
  ).toMatchObject({ checked: true })
})
