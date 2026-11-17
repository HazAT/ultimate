import { expect, it } from 'vitest'
import { criteriaOf, sectionsOf, verbatim } from '../../body.tsx'
import { progressLabel } from '../../progress.tsx'

const body = [
  'Request: pick 1a.',
  'Selected approach: a <projects> section.',
  'Scope in: extensions/messages. Out: UI.',
  'Acceptance criteria:',
  '1. <projects> lists projects.',
  '2. pnpm check passes,',
  '   with tests.',
  'Risks: render cost.',
].join('\n')

it('splits a coordinator body at its section labels', () => {
  expect(sectionsOf(body)).toEqual([
    { label: 'Request', text: 'pick 1a.' },
    { label: 'Selected approach', text: 'a <projects> section.' },
    { label: 'Scope', text: 'in: extensions/messages. Out: UI.' },
    {
      label: 'Acceptance criteria',
      text: '1. <projects> lists projects.\n2. pnpm check passes,\n   with tests.',
    },
    { label: 'Risks', text: 'render cost.' },
  ])
  expect(criteriaOf(sectionsOf(body)![3].text)).toEqual([
    '<projects> lists projects.',
    'pnpm check passes, with tests.',
  ])
  expect(sectionsOf('Just *Markdown*\n\n- a list')).toBeUndefined()
})

it('keeps tags and line breaks as written, outside code', () => {
  expect(verbatim('a <projects>\nb `<x>`\n\n```\n<y>\n```')).toBe(
    'a &lt;projects>  \nb `<x>`\n\n```\n<y>\n```',
  )
})

it('labels a task-less epic by its status and criteria', () => {
  expect(progressLabel({ key: 'E1', status: 'planning', body, tasks: {} })).toBe(
    'planning · 2 criteria',
  )
  expect(progressLabel({ key: 'E1', status: 'in_progress', body: 'Do it.', tasks: {} })).toBe(
    'in progress',
  )
})
