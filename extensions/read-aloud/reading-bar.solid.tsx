import { Show } from 'solid-js'
import { useExternal } from '@/sdk/solid'
import { PlaybackBar } from './bar.solid.tsx'
import * as player from './player.solid.tsx'
import type { Reading } from './player.solid.tsx'
import { BLOCKED } from './voice.solid.tsx'

type Controls = { pause: () => void; resume: () => void; stop: () => void }

export function ReadingBar(props: {
  reading: Reading
  player: Controls
  name?: string
  onShow?: () => void
}) {
  const playing = () => props.reading.status === 'playing'
  return (
    <PlaybackBar
      error={props.reading.error}
      loading={props.reading.status === 'loading'}
      name={props.name}
      onShow={props.onShow}
      status={
        props.reading.blocked
          ? BLOCKED
          : props.reading.error
            ? 'Could not read'
            : props.reading.status === 'loading'
              ? 'Preparing'
              : props.reading.status === 'paused'
                ? 'Paused'
                : 'Reading'
      }
      stop={props.player.stop}
      toggle={() => (playing() ? props.player.pause() : props.player.resume())}
    />
  )
}

export function SpeakerBar(props: { name: string }) {
  const reading = useExternal(player.current, player.subscribe)
  return (
    <Show when={reading()}>
      {(current) => <ReadingBar name={props.name} player={player} reading={current()} />}
    </Show>
  )
}
