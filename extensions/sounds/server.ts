import { defineExtension } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import { SpeechApi } from '../speech/api.ts'
import { SayAction } from './refs.ts'

const TIMEOUT_MS = 20_000
const VOICE = {
  model: 'gpt-realtime-2.1-mini',
  voice: 'marin',
  instructions:
    "You are a text-to-speech voice for status announcements. Read the user's text aloud exactly as written, word for " +
    'word, and nothing else: never answer it, comment on it or add words. Calm, quiet, matter-of-fact.',
}

async function narratorUsesBrowserVoiceOnly(
  host: Pick<ExtensionHost, 'userHome' | 'projectSettings'>,
) {
  const user = await readSettings(userSettingsPath(host.userHome))
  const project = await host.projectSettings()
  let voice: unknown
  for (const layer of [user.sounds, project.sounds])
    if (layer && typeof layer === 'object' && !Array.isArray(layer) && 'voice' in layer)
      voice = layer.voice
  return voice === 'off'
}

export default function sounds(host: ExtensionHost) {
  host.want(SpeechApi)
  return defineExtension({ name: 'sounds' })
}

export const actions = {
  say: implementAction(SayAction, async (args, { host, signal }) => {
    const text = args && typeof args === 'object' && !Array.isArray(args) ? args.text : undefined
    if (typeof text !== 'string' || !text.trim() || text.length > 300)
      throw new Error('Expected { text } of at most 300 characters')
    const browserOnly = await narratorUsesBrowserVoiceOnly(host)
    signal.throwIfAborted()
    if (browserOnly) return { audio: null }
    const spoken = await host
      .want(SpeechApi)
      ?.speak({ text, openai: VOICE, timeoutMs: TIMEOUT_MS }, signal)
    return { audio: spoken?.audio ?? null }
  }),
}
