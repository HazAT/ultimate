import { expect, it } from 'vitest'
import { orderedByLastShown } from '../server.ts'

const instance = (url: string, current = false) => ({ url, current })
const shownUrls = (projects: { url: string }[]) => projects.map((project) => project.url)

const a = instance('http://127.0.0.1:4747')
const b = instance('http://127.0.0.1:4748')
const c = instance('http://127.0.0.1:4749')
const projects = [a, b, c]

it('keeps project order until an instance was shown', () => {
  expect(orderedByLastShown(projects, {})).toEqual(projects)
})

it('puts the instance shown last first and the one shown before it second', () => {
  const shown = { [a.url]: 1, [b.url]: 2 }
  expect(shownUrls(orderedByLastShown(projects, shown))).toEqual([b.url, a.url, c.url])
})

it('keeps project order between two instances shown in the same millisecond', () => {
  const shown = { [c.url]: 5, [a.url]: 5 }
  expect(shownUrls(orderedByLastShown(projects, shown))).toEqual([a.url, c.url, b.url])
})

it('ignores a stamp naming no running instance', () => {
  const shown = { 'http://127.0.0.1:1': 9, [c.url]: 3 }
  expect(orderedByLastShown(projects, shown)).toEqual([c, a, b])
})

it('puts the page’s own instance first among several, the one shown before it second', () => {
  const here = instance('http://127.0.0.1:4750', true)
  const list = [a, b, c, here]
  const shown = { [a.url]: 1, [b.url]: 2, [c.url]: 3, [here.url]: 4 }
  expect(shownUrls(orderedByLastShown(list, shown))).toEqual([here.url, c.url, b.url, a.url])
})
