import { describe, expect, it } from 'vitest'
import {
  atLastLine,
  newer,
  older,
  readHistory,
  remembered,
  rememberPrompt,
} from '../../web/src/app/prompt-history.ts'

const memory = (): Storage => {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (name) => items.get(name) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (name) => void items.delete(name),
    setItem: (name, value) => void items.set(name, value),
  }
}

describe('remembered', () => {
  it('appends the trimmed prompt and moves a repeat to the end, like HIST_IGNORE_ALL_DUPS', () => {
    expect(remembered(['a', 'b'], '  c \n')).toEqual(['a', 'b', 'c'])
    expect(remembered(['a', 'b', 'c'], 'a')).toEqual(['b', 'c', 'a'])
  })
  it('skips empty prompts', () => {
    expect(remembered(['a'], '   ')).toEqual(['a'])
  })
  it('keeps the newest 500', () => {
    const long = Array.from({ length: 500 }, (_, i) => `p${i}`)
    const next = remembered(long, 'new')
    expect(next).toHaveLength(500)
    expect(next[0]).toBe('p1')
    expect(next.at(-1)).toBe('new')
  })
})

describe('rememberPrompt and readHistory', () => {
  it('round-trip through storage and survive garbage', () => {
    const storage = memory()
    rememberPrompt('first', storage)
    rememberPrompt('second', storage)
    expect(readHistory(storage)).toEqual(['first', 'second'])
    storage.setItem('ultimate.prompt-history', '{not json')
    expect(readHistory(storage)).toEqual([])
  })
})

describe('older and newer', () => {
  const history = ['git status', 'fix the test', 'git push', 'git push']
  it('walks back from an empty composer through every prompt, skipping what is already shown', () => {
    const one = older(history, undefined, '')!
    expect(one.shown).toBe('git push')
    const two = older(history, one, one.shown)!
    expect(two.shown).toBe('fix the test')
    const three = older(history, two, two.shown)!
    expect(three.shown).toBe('git status')
    expect(older(history, three, three.shown)).toBeUndefined()
  })
  it('only offers prompts starting with what was typed before the first ↑', () => {
    const one = older(history, undefined, 'git')!
    expect(one).toEqual({ typed: 'git', at: 3, shown: 'git push' })
    const two = older(history, one, one.shown)!
    expect(two.shown).toBe('git status')
  })
  it('walks forward and ends on what was typed', () => {
    const one = older(history, undefined, 'git')!
    const two = older(history, one, one.shown)!
    const back = newer(history, two, two.shown)!
    expect(back.shown).toBe('git push')
    const end = newer(history, back, back.shown)!
    expect(end).toEqual({ typed: 'git', at: history.length, shown: 'git' })
  })
  it('offers nothing when no prompt matches', () => {
    expect(older(history, undefined, 'deploy')).toBeUndefined()
    expect(older([], undefined, '')).toBeUndefined()
  })
})

describe('atLastLine', () => {
  it('is true when no line break follows the caret', () => {
    expect(atLastLine('', 0)).toBe(true)
    expect(atLastLine('one\ntwo', 5)).toBe(true)
    expect(atLastLine('one\ntwo', 2)).toBe(false)
  })
})
