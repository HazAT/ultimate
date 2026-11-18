Speech is the one place Ultimate generates a spoken voice: the Sounds narrator and Read aloud hand it text and get audio back, from OpenAI, a local command or an engine another extension provides.

It adds no UI, tools or prompt. Callers reach it through `SpeechApi` (`api.ts`): `speak({ text, openai, timeoutMs }, signal)` answers base64 audio with its MIME type, or null to leave the text to the browser's `speechSynthesis`. Results are kept in memory by engine and text (the newest 64 MB), so a replay is instant and free; a restart clears them. With the extension disabled every caller uses the browser's voice.

## The `speech` setting

`speech.voice` names the engine for every caller. User settings (`~/.ultimate/settings.json`) and trusted project
settings merge by `speech` member, project winning.

| `speech.voice`    | Engine                                                                                                                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| unset, `"openai"` | OpenAI, with the `OPENAI_API_KEY` secret or an API key Pi's `openai` provider holds. Each caller names its own model, voice and instructions (`openai` in the request): a realtime model answers over one realtime WebSocket response, any other over `/v1/audio/speech`. The text goes to OpenAI. Without a key the browser speaks. |
| `"command"`       | The local program in `speech.command`, below.                                                                                                                                                                                                                                                                                        |
| another name      | The engine an enabled extension provides under that id, below.                                                                                                                                                                                                                                                                       |
| `"off"`           | No generated audio: the browser's voice speaks.                                                                                                                                                                                                                                                                                      |

A local engine that is missing, fails or runs past the caller's deadline leaves that text to the browser's voice,
**never to OpenAI**, and is tried again next time. An OpenAI failure is the caller's error, as before.

## A local command

```json
{
  "speech": {
    "voice": "command",
    "command": ["/absolute/path/my-tts"]
  }
}
```

The command (`speakCommand` in `lib/speech.ts`) receives the text as UTF-8 on stdin, followed by EOF, and writes one
audio file to stdout: WAV, MP3 or AAC (ADTS or MP4), recognised by its headers, or headerless signed PCM16
little-endian, mono, at 24 kHz, which is wrapped in a WAV. Diagnostics belong on stderr, and it must exit successfully.
Arguments are literal, with no `~`, variable or pipe expansion unless you run a shell; use absolute paths. Ultimate does
not install a runtime or model, convert audio, or manage a daemon: voice, rate and model belong to the command. Audio
length is not limited; each caller gives a deadline (the narrator 20 s a line, read aloud 60 s a section). Failures are
logged with bounded stderr. Cancellation kills the command, not a separate service or its descendants; wrappers own
their child processes and temporary files.

**macOS:** built-in `say` writes a WAV with `say --file-format=WAVE --data-format=LEI16@24000 -o <file>`, using an
installed system voice. It cannot write to stdout, so the command writes a temporary file and prints it; use this as the
final argument of `speech.command: ["sh", "-c", "…"]`:

```sh
dir=$(mktemp -d) || exit; trap 'rm -rf "$dir"' EXIT
/usr/bin/say --file-format=WAVE --data-format=LEI16@24000 -o "$dir/speech.wav" && cat "$dir/speech.wav"
```

## An engine from another extension

An extension that holds a voice itself (an in-process model, a client of a running service) provides the
`speech.engine` extension point instead of a command, and `speech.voice` set to its id selects it:

```ts
import { SpeechEngine } from '../speech/api.ts'
import { audioOf } from '../../lib/speech.ts'

export default function kokoro(host: ExtensionHost) {
  host.implement(SpeechEngine, {
    id: 'kokoro',
    async speak(text, signal) {
      const { audio, mimeType } = audioOf(await synthesize(text, signal))
      return { audio: audio.toString('base64'), mimeType }
    },
  })
  return defineExtension({ name: 'kokoro' })
}
```

`audioOf` names a file's type and wraps raw PCM16; `wavOf` wraps PCM at another sample rate. The catalogue
(`ultimate.catalogue()`) lists `speech.engine` with its provider. One extension provides the point at a time.
