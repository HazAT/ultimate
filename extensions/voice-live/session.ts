import type { ConversationId } from '@earendil-works/pi-durable'
import { deadline, every, within } from '../../lib/timers.ts'
import { inProcess, settled } from '../../lib/errors.ts'
import type { Cancel } from '../../lib/timers.ts'
import type { ActionRef } from '../../shared/extension-api.ts'
import { EndAction, HeardAction, LogAction, StartAction } from './refs.ts'
import { Relay } from './relay.ts'
import type { LiveEvent, RelayOut } from './relay.ts'

export type LiveOptions = {
  action: <A, R>(ref: ActionRef<A, R>, args: A) => Promise<R>
  onEvent: (event: LiveEvent) => void
  onError: (error: Error) => void
}
export type LiveSession = {
  conversation: ConversationId
  analyser: AnalyserNode
  relay: Relay
  send: (event: Record<string, unknown>) => void
  mute: () => void
  unmute: () => void
  speak: (text: string) => void
  close: () => Promise<void>
}

function openPreOfferChannel(peer: RTCPeerConnection) {
  return peer.createDataChannel('oai-events')
}

export async function startMicInGesture(options: LiveOptions): Promise<LiveSession> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const pc = new RTCPeerConnection()
  const audio = new Audio()
  audio.autoplay = true
  const audioContext = new AudioContext()
  const analyser = audioContext.createAnalyser()
  audioContext.createMediaStreamSource(stream).connect(analyser)
  const relay = new Relay(Date.now())
  const started = Promise.withResolvers<void>()
  const closeAcknowledged = Promise.withResolvers<void>()
  inProcess('a browser session ends with its page', settled(started.promise))
  let stopPolling: Cancel | undefined
  let cancelStartup: Cancel | undefined
  let seconds: number | undefined
  let didStart = false
  let didClose = false
  let releasing = false
  let closePromise: Promise<void> | undefined
  let orderedLineDelivery = Promise.resolve()
  let conversation: ConversationId | undefined
  const errorOf = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
  const releaseMicrophoneAndPeer = async () => {
    if (releasing) return
    releasing = true
    stopPolling?.()
    cancelStartup?.()
    stream.getTracks().forEach((track) => track.stop())
    pc.close()
    audio.pause()
    audio.srcObject = null
    await audioContext.close()
  }
  const send = (event: Record<string, unknown>) => {
    if (channel.readyState !== 'open') throw new Error('Live voice data channel is not open')
    channel.send(JSON.stringify(event))
  }
  const deliverFinishedLinesInOrder = (outs: RelayOut[]) => {
    for (const out of outs) {
      orderedLineDelivery = orderedLineDelivery
        .then(async () => {
          if ('log' in out) {
            await options.action(LogAction, out.log)
            return
          }
          await options.action(HeardAction, { text: out.heard })
        })
        .catch((error: unknown) => {
          options.onError(errorOf(error))
        })
    }
  }
  pc.addEventListener('track', (event) => {
    audio.srcObject = event.streams[0] ?? new MediaStream([event.track])
    void audio.play().catch((error: unknown) => options.onError(errorOf(error)))
  })
  stream.getTracks().forEach((track) => pc.addTrack(track, stream))

  const channel = openPreOfferChannel(pc)
  channel.addEventListener('message', (message) => {
    try {
      const event = JSON.parse(String(message.data)) as LiveEvent
      if (event.type === 'session.started') {
        didStart = true
        started.resolve()
      }
      if (event.type === 'session.usage.updated') seconds = event.usage?.seconds
      if (event.type === 'session.closed') {
        didClose = true
        closeAcknowledged.resolve()
        if (!didStart) started.reject(new Error('Live voice closed before session.started'))
      }
      if (event.type === 'error') {
        const error = new Error(`Live voice: ${JSON.stringify(event.error ?? event)}`)
        started.reject(error)
        options.onError(error)
      }
      deliverFinishedLinesInOrder(relay.event(event, Date.now()))
      options.onEvent(event)
      if (event.type === 'session.closed' && conversation !== undefined)
        void close().catch((error: unknown) => options.onError(errorOf(error)))
    } catch (error) {
      options.onError(errorOf(error))
    }
  })
  channel.addEventListener('close', () => {
    if (releasing) return
    if (!didStart) started.reject(new Error('Live voice closed before session.started'))
    if (!didClose) {
      options.onError(new Error('Live voice connection closed unexpectedly'))
      void close().catch((error: unknown) => options.onError(errorOf(error)))
    }
  })
  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    closePromise = (async () => {
      stopPolling?.()
      try {
        if (!didClose) {
          send({ type: 'session.close' })
          await within(
            5000,
            closeAcknowledged.promise,
            () => new Error('Live voice did not confirm session.closed'),
          )
        }
      } finally {
        await releaseMicrophoneAndPeer()
        await orderedLineDelivery
        if (conversation !== undefined)
          await options.action(EndAction, seconds === undefined ? {} : { seconds })
      }
    })()
    return closePromise
  }
  try {
    cancelStartup = deadline(30_000, () =>
      started.reject(new Error('Timed out waiting for session.started')),
    )
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const answer = await options.action(StartAction, { sdp: offer.sdp! })
    conversation = answer.conversation
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
    await started.promise
    cancelStartup?.()
    await audioContext.resume()
    stopPolling = every(100, () => deliverFinishedLinesInOrder(relay.tick(Date.now())))
    return {
      conversation: answer.conversation,
      analyser,
      relay,
      send,
      mute: () => {
        stream.getAudioTracks().forEach((track) => {
          track.enabled = false
        })
        send({ type: 'session.input_audio.mute' })
      },
      unmute: () => {
        stream.getAudioTracks().forEach((track) => {
          track.enabled = true
        })
        send({ type: 'session.input_audio.unmute' })
      },
      speak: (text) => {
        relay.spoke()
        send({
          type: 'session.commentary.append',
          event_id: crypto.randomUUID(),
          delegation_id: null,
          content: text,
        })
      },
      close,
    }
  } catch (error) {
    if (conversation !== undefined)
      await close().catch((cause: unknown) => options.onError(errorOf(cause)))
    else await releaseMicrophoneAndPeer()
    throw error
  }
}
