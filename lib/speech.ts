import { spawn } from './spawn.ts'

export type Audio = { audio: Buffer; mimeType: string }

export function wavOf(pcm: Buffer, sampleRate = 24000) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

const mp3Kbps = {
  mpeg1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  mpeg2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}

function mp3FrameLength(audio: Buffer, at: number) {
  if (at + 4 > audio.length || audio[at] !== 0xff || (audio[at + 1] & 0xe0) !== 0xe0) return 0
  const version = (audio[at + 1] >> 3) & 3
  const layer3 = ((audio[at + 1] >> 1) & 3) === 1
  const bitrate = audio[at + 2] >> 4
  const rate = (audio[at + 2] >> 2) & 3
  if (version === 1 || !layer3 || bitrate === 0 || bitrate === 15 || rate === 3) return 0
  const mpeg1 = version === 3
  const sampleRate = [44100, 48000, 32000][rate] / (mpeg1 ? 1 : version === 2 ? 2 : 4)
  const kbps = (mpeg1 ? mp3Kbps.mpeg1 : mp3Kbps.mpeg2)[bitrate]
  return Math.floor(((mpeg1 ? 144 : 72) * kbps * 1000) / sampleRate) + ((audio[at + 2] >> 1) & 1)
}

function adtsFrameLength(audio: Buffer, at: number) {
  if (at + 7 > audio.length || audio[at] !== 0xff || (audio[at + 1] & 0xf6) !== 0xf0) return 0
  if (((audio[at + 2] >> 2) & 0xf) > 12) return 0
  const length = ((audio[at + 3] & 3) << 11) | (audio[at + 4] << 3) | (audio[at + 5] >> 5)
  return length >= 7 ? length : 0
}

const framed = (audio: Buffer, frameLength: (audio: Buffer, at: number) => number) => {
  const first = frameLength(audio, 0)
  return first > 0 && (first === audio.length || frameLength(audio, first) > 0)
}

export function audioOf(output: Buffer): Audio {
  if (!output.length) throw new Error('Speech command returned no audio')
  const ascii = (from: number, to: number) => output.toString('ascii', from, to)
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE')
    return { audio: output, mimeType: 'audio/wav' }
  if (ascii(4, 8) === 'ftyp') return { audio: output, mimeType: 'audio/mp4' }
  if (ascii(0, 3) === 'ID3' || framed(output, mp3FrameLength))
    return { audio: output, mimeType: 'audio/mpeg' }
  if (framed(output, adtsFrameLength)) return { audio: output, mimeType: 'audio/aac' }
  if (output.length % 2) throw new Error('Speech command returned neither WAV, MP3, AAC nor PCM16')
  return { audio: wavOf(output), mimeType: 'audio/wav' }
}

export function speakCommand(command: string[], text: string, signal: AbortSignal) {
  signal.throwIfAborted()
  return new Promise<Audio>((resolve, reject) => {
    const child = spawn(command[0], command.slice(1))
    const chunks: Buffer[] = []
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
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(0, 4096)
    })
    child.on('close', (code) => {
      signal.removeEventListener('abort', abort)
      if (code !== 0)
        return reject(
          new Error(`Speech command exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`),
        )
      try {
        resolve(audioOf(Buffer.concat(chunks)))
      } catch (error) {
        reject(error)
      }
    })
    if (signal.aborted) abort()
    else child.stdin.end(text)
  })
}
