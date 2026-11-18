import { expect, it } from 'vitest'
import { delegatedCore } from '../lib/cgroup.ts'

it('finds the delegated core cgroup and nothing else', () => {
  expect(delegatedCore('0::/user.slice/app.slice/ultimate.service/core')).toBe(
    '/sys/fs/cgroup/user.slice/app.slice/ultimate.service/core',
  )
  expect(delegatedCore('0::/user.slice/app.slice/ultimate.service')).toBeUndefined()
  expect(delegatedCore('1:name=systemd:/user.slice/core')).toBeUndefined()
})
