import { expect, it } from 'vitest'
import { speakCommand } from '../../command.ts'

it('sends literal text on stdin and returns the command PCM', async () => {
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
  ).toEqual(Buffer.from([0, 0, 255, 127]))
})

it('rejects failed commands with their stderr', async () => {
  const script = `process.stdin.resume(); process.stdin.on('end', () => {
    process.stderr.write('Speech runtime unavailable')
    process.exitCode = 7
  })`
  await expect(
    speakCommand([process.execPath, '-e', script], 'A line.', new AbortController().signal),
  ).rejects.toThrow('Narrator command exited 7: Speech runtime unavailable')
})
