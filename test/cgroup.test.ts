import { expect, it } from 'vitest'
import { delegatedCore, ownerAlive } from '../lib/cgroup.ts'

it('finds the delegated core cgroup and nothing else', () => {
  expect(delegatedCore('0::/user.slice/app.slice/ultimate.service/core')).toBe(
    '/sys/fs/cgroup/user.slice/app.slice/ultimate.service/core',
  )
  expect(delegatedCore('0::/user.slice/app.slice/ultimate.service')).toBeUndefined()
  expect(delegatedCore('1:name=systemd:/user.slice/core')).toBeUndefined()
})

it('takes a leaf without a pid prefix for one whose owner is gone', () => {
  expect(ownerAlive(`${process.pid}-a1b2`)).toBe(true)
  expect(ownerAlive('0-a1b2')).toBe(false)
  expect(ownerAlive('leftover')).toBe(false)
})
