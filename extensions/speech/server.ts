import { defineExtension } from '@earendil-works/pi-durable'
import type { JsonObject } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { openaiSecretOrNonOAuthKey } from '../../lib/openai.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import { SpeechApi, SpeechEngine } from './api.ts'
import type { SpeechService, Spoken } from './api.ts'
import { speakCommand } from '../../lib/speech.ts'
import type { Audio } from '../../lib/speech.ts'
import { openaiVoice } from './openai.ts'

const CACHED_BASE64_CHARACTERS = 64_000_000

type Host = Pick<
  ExtensionHost,
  'userHome' | 'projectSettings' | 'modelRuntime' | 'want' | 'resource'
>

async function settings(host: Host) {
  const user = await readSettings(userSettingsPath(host.userHome))
  const project = await host.projectSettings()
  const merged: JsonObject = {}
  for (const layer of [user.speech, project.speech])
    if (layer && typeof layer === 'object' && !Array.isArray(layer)) Object.assign(merged, layer)
  const { voice, command } = merged
  return {
    voice: typeof voice === 'string' ? voice : 'openai',
    command:
      Array.isArray(command) &&
      command.length > 0 &&
      command.every((arg) => typeof arg === 'string') &&
      command[0].trim()
        ? command
        : undefined,
  }
}

const encoded = ({ audio, mimeType }: Audio): Spoken => ({
  audio: audio.toString('base64'),
  mimeType,
})

const aborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true })
  })

const speak =
  (host: Host): SpeechService['speak'] =>
  async ({ text, openai, timeoutMs }, signal) => {
    const { voice, command } = await settings(host)
    signal.throwIfAborted()
    if (voice === 'off') return null
    const cache = host.resource('speech.spoken', () => new Map<string, Spoken>())
    const key = JSON.stringify(voice === 'openai' ? [voice, openai, text] : [voice, command, text])
    const builtIn = voice === 'openai' || voice === 'command'
    const engine = builtIn ? undefined : host.want(SpeechEngine)
    const provided = engine?.id === voice ? engine : undefined
    const cached = builtIn || provided ? cache.get(key) : undefined
    if (cached) return cached
    const speaking = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    let spoken: Spoken
    if (voice === 'openai') {
      const apiKey = await openaiSecretOrNonOAuthKey(host, speaking)
      if (!apiKey) return null
      spoken = encoded(await openaiVoice(apiKey, text, openai, speaking))
    } else {
      try {
        if (voice === 'command') {
          if (!command) throw new Error('speech.command is not set')
          spoken = encoded(await speakCommand(command, text, speaking))
        } else if (provided)
          spoken = await Promise.race([provided.speak(text, speaking), aborted(speaking)])
        else throw new Error(`No enabled extension provides the speech engine "${voice}"`)
      } catch (error) {
        signal.throwIfAborted()
        console.warn('Speech failed, leaving it to the browser', error)
        return null
      }
    }
    signal.throwIfAborted()
    cache.set(key, spoken)
    let held = 0
    for (const { audio } of cache.values()) held += audio.length
    for (const [oldest, { audio }] of cache) {
      if (held <= CACHED_BASE64_CHARACTERS) break
      cache.delete(oldest)
      held -= audio.length
    }
    return spoken
  }

export default function speech(host: ExtensionHost) {
  host.want(SpeechEngine)
  host.implement(SpeechApi, { speak: speak(host) })
  return defineExtension({ name: 'speech' })
}
