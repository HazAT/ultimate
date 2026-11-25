import { expect, it } from 'vitest'
import { saidIn } from '../../turns.solid.tsx'

const line =
  'Attached video: `Screen recording.webm` (12 s), id `v_ab12`; ask about it with video_ask'

it('a sent voice turn keeps the video line it carried once its clip is transcribed', () => {
  const transcripts = { 'clip-1': 'look at this' }
  const sent = { key: 'k', audio: 'clip-1', seconds: 2 }
  expect(
    saidIn(
      { ...sent, route: 'text', text: `look at this\n\n${line}` },
      'clip-1',
      true,
      transcripts,
    ),
  ).toBe(`look at this\n\n${line}`)
  expect(saidIn({ ...sent, route: 'audio', text: line }, 'clip-1', true, transcripts)).toBe(
    `look at this\n\n${line}`,
  )
  expect(saidIn({ ...sent, route: 'text', text: '' }, 'clip-1', true, { 'clip-1': '' })).toBe('')
})
