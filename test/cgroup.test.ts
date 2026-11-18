import { expect, it } from 'vitest'
import { delegatedCore, enterWork } from '../lib/cgroup.ts'

it('finds the delegated core cgroup and nothing else', () => {
  expect(delegatedCore('0::/user.slice/app.slice/ultimate.service/core')).toBe(
    '/sys/fs/cgroup/user.slice/app.slice/ultimate.service/core',
  )
  expect(delegatedCore('0::/user.slice/app.slice/ultimate.service')).toBeUndefined()
  expect(delegatedCore(undefined)).toBeUndefined()
})

it('spawns unchanged without a work cgroup, and through its own leaf with one', () => {
  expect(enterWork('bash', ['-c', 'x'], undefined)).toMatchObject({
    program: 'bash',
    args: ['-c', 'x'],
  })
  const work = enterWork('bash', ['-c', 'x'], '/sys/fs/cgroup/u/ultimate.service/work')
  expect(work.program).toBe('/bin/sh')
  expect(work.args.slice(2, 3)[0]).toMatch(/^\/sys\/fs\/cgroup\/u\/ultimate.service\/work\/[\w-]+$/)
  expect(work.args.slice(3)).toEqual(['bash', '-c', 'x'])
})
