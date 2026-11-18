import { expect, it } from 'vitest'
import { speakCommand, wavOf } from '../../lib/speech.ts'

const pcm = Buffer.from([0, 0, 255, 127])

it('sends literal text on stdin and wraps headerless PCM in a WAV', async () => {
  const text = 'Literal "$HOME"; echo not-a-command.'
  const script = `
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => text += chunk)
    process.stdin.on('end', () => {
      if (text !== process.argv[1]) process.exit(2)
      process.stdout.write(Buffer.from([0, 0, 255, 127]))
    })
  `
  expect(
    await speakCommand([process.execPath, '-e', script, text], text, new AbortController().signal),
  ).toEqual({ audio: wavOf(pcm), mimeType: 'audio/wav' })
})

it('takes output longer than a minute of audio', async () => {
  const seconds = 90
  const script = `process.stdin.resume(); process.stdin.on('end', () =>
    process.stdout.write(Buffer.alloc(24000 * 2 * ${seconds})))`
  const { audio, mimeType } = await speakCommand(
    [process.execPath, '-e', script],
    'A long section.',
    new AbortController().signal,
  )
  expect(mimeType).toBe('audio/wav')
  expect(audio.length).toBe(44 + 24000 * 2 * seconds)
})

it('rejects failed commands with their stderr', async () => {
  const script = `process.stdin.resume(); process.stdin.on('end', () => {
    process.stderr.write('Speech runtime unavailable')
    process.exitCode = 7
  })`
  await expect(
    speakCommand([process.execPath, '-e', script], 'A line.', new AbortController().signal),
  ).rejects.toThrow('Speech command exited 7: Speech runtime unavailable')
})
