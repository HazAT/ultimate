import { expect, it } from 'vitest'
import { audioOf, wavOf } from '../lib/speech.ts'

const pcm = Buffer.from([0, 0, 255, 127])

it('detects WAV, MP3 and AAC from their first bytes and wraps headerless PCM16 as WAV', () => {
  const wav = wavOf(pcm)
  expect(wav.subarray(0, 4).toString()).toBe('RIFF')
  expect(wav.readUInt32LE(24)).toBe(24000)
  expect(wav.subarray(44)).toEqual(pcm)
  expect(audioOf(wav)).toEqual({ audio: wav, mimeType: 'audio/wav' })
  expect(audioOf(pcm)).toEqual({ audio: wav, mimeType: 'audio/wav' })
  const id3 = Buffer.from('ID3\u0004\u0000')
  expect(audioOf(id3).mimeType).toBe('audio/mpeg')
  const mp3Frame = Buffer.alloc(417)
  mp3Frame.set([0xff, 0xfb, 0x90, 0x00])
  expect(audioOf(Buffer.concat([mp3Frame, mp3Frame])).mimeType).toBe('audio/mpeg')
  const adtsFrame = Buffer.alloc(9)
  adtsFrame.set([0xff, 0xf1, 0x50, 0x80, 0x01, 0x3f, 0xfc])
  expect(audioOf(Buffer.concat([adtsFrame, adtsFrame])).mimeType).toBe('audio/aac')
  const m4a = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A ')])
  expect(audioOf(m4a).mimeType).toBe('audio/mp4')
})

it('keeps PCM whose samples look like an MP3 or AAC sync word as PCM', () => {
  for (const samples of [
    [0xff, 0xff, 0, 0],
    [0xff, 0xf0, 0, 0],
    [0xff, 0xfb, 0, 0, 1, 2],
  ]) {
    const pcm16 = Buffer.from(samples)
    expect(audioOf(pcm16)).toEqual({ audio: wavOf(pcm16), mimeType: 'audio/wav' })
  }
})

it('refuses empty or odd-length output it cannot recognise', () => {
  expect(() => audioOf(Buffer.alloc(0))).toThrow('Speech command returned no audio')
  expect(() => audioOf(Buffer.from([1, 2, 3]))).toThrow(
    'Speech command returned neither WAV, MP3, AAC nor PCM16',
  )
})
