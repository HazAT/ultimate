import { expect, it } from 'vitest'
import type { Dream, Prepared, Sleep } from '../refs.ts'
import { dreamStage } from '../stage.ts'

const dream: Dream = { branch: 7, requested: 1, at: 100 }
const prepared: Prepared = { chapter: 'Two', learned: [], handoff: '', at: 200 }
const sleep = (phase: Sleep['phase']): Sleep => ({ chapter: 'Two', phase, at: 300 })
const concluded = (id: number) => (id === 7 ? Infinity : undefined)
const open = () => undefined

it.each<[string, Parameters<typeof dreamStage>[0], typeof concluded, string]>([
  ['no dream', {}, concluded, 'none'],
  ['the dream branch still runs', { dream }, open, 'none'],
  ['the dream branch concluded', { dream }, concluded, 'woke'],
  ['the user stays in this chapter', { dream: { ...dream, dismissed: true } }, concluded, 'none'],
  ['the user pressed Fall asleep', { dream: { ...dream, asked: 150 } }, concluded, 'preparing'],
  [
    'a chapter prepared after the dream',
    { dream: { ...dream, asked: 150 }, prepared },
    open,
    'prepared',
  ],
  ['a chapter prepared without a dream', { prepared }, open, 'prepared'],
  [
    'a stale chapter from before the dream',
    { dream, prepared: { ...prepared, at: 50 } },
    concluded,
    'woke',
  ],
  ['falling asleep', { dream, prepared, sleep: sleep('backing up') }, concluded, 'sleeping'],
  ['switching', { dream, prepared, sleep: sleep('switching') }, concluded, 'sleeping'],
  ['falling asleep failed', { dream, prepared, sleep: sleep('failed') }, concluded, 'failed'],
  ['asleep in the next chapter', { dream, prepared, sleep: sleep('asleep') }, concluded, 'asleep'],
])('%s', (_, doc, concludedSince, stage) => {
  expect(dreamStage(doc, concludedSince)).toBe(stage)
})
