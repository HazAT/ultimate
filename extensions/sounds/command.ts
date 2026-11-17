import { spawn } from '../../lib/spawn.ts'

const MAX_AUDIO_BYTES = 24000 * 2 * 60

export function pcmOf(audio: Buffer) {
  let pcm = audio
  if (audio.toString('ascii', 0, 4) === 'RIFF' && audio.toString('ascii', 8, 12) === 'WAVE') {
    const end = audio.readUInt32LE(4) + 8
    if (end < 12 || end > audio.length) throw new Error('Truncated narrator WAV')
    let format = false
    let data: Buffer | undefined
    for (let at = 12; at < end;) {
      if (at + 8 > end) throw new Error('Truncated narrator WAV chunk')
      const name = audio.toString('ascii', at, at + 4)
      const size = audio.readUInt32LE(at + 4)
      const start = at + 8
      const next = start + size + (size % 2)
      if (next > end) throw new Error('Truncated narrator WAV chunk')
      if (name === 'fmt ') {
        if (
          size < 16 ||
          audio.readUInt16LE(start) !== 1 ||
          audio.readUInt16LE(start + 2) !== 1 ||
          audio.readUInt32LE(start + 4) !== 24000 ||
          audio.readUInt16LE(start + 14) !== 16
        )
          throw new Error('Narrator WAV must be PCM format 1, mono, 24000 Hz, 16-bit')
        format = true
      } else if (name === 'data') data = audio.subarray(start, start + size)
      at = next
    }
    if (!format || !data) throw new Error('Narrator WAV requires fmt and data chunks')
    pcm = data
  }
  if (!pcm.length || pcm.length % 2) throw new Error('Narrator command must return nonempty PCM16')
  return pcm
}

export function speakCommand(command: string[], text: string, signal: AbortSignal) {
  signal.throwIfAborted()
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(command[0], command.slice(1))
    const chunks: Buffer[] = []
    let bytes = 0
    let stderr = ''
    const fail = (error: Error) => {
      reject(error)
      child.kill('SIGKILL')
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
    }
    const abort = () => fail(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    child.on('error', fail)
    child.stdin.on('error', fail)
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_AUDIO_BYTES)
        return fail(new Error('Narrator command audio exceeds 60 seconds'))
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(0, 4096)
    })
    child.on('close', (code) => {
      signal.removeEventListener('abort', abort)
      if (code !== 0)
        return reject(
          new Error(`Narrator command exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`),
        )
      try {
        resolve(pcmOf(Buffer.concat(chunks)))
      } catch (error) {
        reject(error)
      }
    })
    if (signal.aborted) abort()
    else child.stdin.end(text)
  })
}
