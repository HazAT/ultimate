export type Typed = {
  text: string
  images: readonly { data: string; mimeType: string }[]
}

export type Note =
  | 'kept going'
  | 'too short tap'
  | 'too short hold'
  | 'heard nothing'
  | 'nothing sent'
  | 'collecting'
  | 'clips changed'

type Turn = { key?: string; note?: Note; replied?: true }

export type Settled =
  | ({ phase: 'idle' } & Turn)
  | ({ phase: 'sending'; voice: boolean; typed?: Typed } & Turn)
  | ({ phase: 'thinking'; words?: true } & Turn)
  | ({ phase: 'speaking' } & Turn)
  | ({ phase: 'done'; stopped?: true } & Turn)
  | { phase: 'error'; key?: string; message: string }

type Recording = {
  phase: 'recording'
  open: boolean
  busy: boolean
  before: Settled
  typed?: Typed
}

export type DockState = Settled | Recording

export type Phase = DockState['phase']

export type DockEvent =
  | { type: 'press'; busy: boolean }
  | { type: 'open' }
  | { type: 'cancel'; paused: boolean }
  | { type: 'enter'; typed?: Typed }
  | {
      type: 'stop'
      retaking: boolean
      spoke: boolean
      collect: boolean
      paused: boolean
      note?: Note
    }
  | { type: 'abandon' }
  | { type: 'interrupt' }
  | { type: 'send'; key: string; voice: boolean }
  | { type: 'sent'; key: string }
  | { type: 'failed'; key: string; message: string }
  | { type: 'silent'; key: string }
  | { type: 'words'; key: string }
  | { type: 'playing'; key: string }
  | { type: 'generated'; key: string }
  | { type: 'stopped'; key: string }
  | { type: 'finished'; key: string }
  | { type: 'note'; note: Note }
  | { type: 'ended' }

type Of<T extends { phase: string }, P extends T['phase']> = Extract<T, { phase: P }>
type Event<E extends DockEvent['type']> = Extract<DockEvent, { type: E }>
type Handlers<S, Out> = { [E in DockEvent['type']]: (state: S, event: Event<E>) => Out }

const notes: Record<Note, string> = {
  'kept going': 'Not enough audio · kept going',
  'too short tap': 'Too short: tap again when you are done',
  'too short hold': 'Too short: hold while you talk',
  'heard nothing': 'Heard nothing: check the mic?',
  'nothing sent': 'No words heard · nothing sent',
  collecting: 'Collecting · say "send it" or press Enter',
  'clips changed': 'The collected clips changed · press Enter to send',
}

export const settled = (state: DockState): Settled =>
  state.phase === 'recording' ? state.before : state

export const shownPhase = (state: DockState): Phase =>
  state.phase === 'recording' && !state.open ? state.before.phase : state.phase

export const pendingKey = (state: DockState) => settled(state).key

export const replying = (state: DockState) => {
  const now = settled(state)
  return (
    now.phase === 'sending' ||
    ((now.phase === 'thinking' || now.phase === 'speaking') && !now.replied)
  )
}

export const pulsing = (state: DockState) => {
  const now = settled(state)
  return now.phase === 'thinking' && !now.words
}

export const typedIn = (state: DockState): Typed | undefined =>
  state.phase === 'recording'
    ? (state.typed ?? typedIn(state.before))
    : state.phase === 'sending'
      ? state.typed
      : undefined

const noted = (state: Of<Settled, 'idle' | 'sending' | 'thinking' | 'speaking' | 'done'>) =>
  state.note && notes[state.note]

const statuses: { [P in Phase]: (state: Of<DockState, P>) => string | undefined } = {
  recording: (state) =>
    !state.open
      ? statusOf(state.before)
      : state.busy
        ? 'Recording · say something to interrupt'
        : 'Recording · I hear you',
  error: (state) => state.message,
  idle: noted,
  sending: (state) => noted(state) ?? (state.voice ? 'Sending your voice…' : 'Sending…'),
  thinking: (state) => noted(state) ?? 'Thinking…',
  speaking: (state) => noted(state) ?? 'Speaking',
  done: (state) => noted(state) ?? (state.stopped ? 'Stopped · your turn' : 'Your turn'),
}

export const statusOf = (state: DockState): string | undefined =>
  (statuses[state.phase] as (state: DockState) => string | undefined)(state)

const keyed = (key: string | undefined) => (key !== undefined ? { key } : {})

const unnoted = (state: Settled): Settled => {
  if (state.phase === 'error' || state.note === undefined) return state
  const { note: _dropped, ...rest } = state
  return rest
}

const resumed = (state: Settled): Settled => ({
  phase: 'speaking',
  ...keyed(state.key),
  ...(state.phase === 'error' || state.phase === 'idle' || state.phase === 'done' || state.replied
    ? { replied: true }
    : {}),
})

const quiet = (state: Settled): Settled =>
  state.phase === 'error'
    ? { phase: 'idle', ...keyed(state.key) }
    : state.phase === 'speaking'
      ? state.replied
        ? { phase: 'done', ...keyed(state.key), replied: true }
        : { phase: 'thinking', words: true, ...keyed(state.key) }
      : unnoted(state)

const ours = (state: Settled, key: string) => state.key === key

const noting = (state: Settled, note: Note): Settled =>
  state.phase === 'error' || state.phase === 'done'
    ? {
        phase: 'idle',
        note,
        ...(state.phase === 'done' ? keyed(state.key) : {}),
        ...(state.phase === 'done' ? { replied: true } : {}),
      }
    : { ...state, note }

const following = (state: Settled, key: string) =>
  ours(state, key) || state.phase === 'idle' || state.phase === 'done' || state.phase === 'error'
const unchanged = <S>(state: S) => state

const settling: Handlers<Settled, Settled> = {
  press: unchanged,
  open: unchanged,
  cancel: unchanged,
  enter: unchanged,
  stop: unchanged,
  ended: () => ({ phase: 'idle' }),
  abandon: (state) => ({ phase: 'idle', ...keyed(state.key) }),
  interrupt: (state) =>
    state.phase === 'error'
      ? { phase: 'idle' }
      : state.phase === 'sending'
        ? { phase: 'sending', voice: state.voice }
        : { ...unnoted(state), key: undefined },
  send: (_state, event) => ({ phase: 'sending', key: event.key, voice: event.voice }),
  sent: (state, event) =>
    state.phase === 'sending' && ours(state, event.key)
      ? { phase: 'thinking', key: event.key }
      : state,
  failed: (state, event) =>
    ours(state, event.key) ? { phase: 'error', key: event.key, message: event.message } : state,
  silent: (state, event) =>
    ours(state, event.key) ? { phase: 'idle', note: 'nothing sent' } : state,
  words: (state, event) =>
    state.phase === 'thinking' && ours(state, event.key) ? { ...state, words: true } : state,
  playing: (state, event) =>
    !following(state, event.key) || (state.phase === 'speaking' && !state.note)
      ? state
      : resumed(state),
  generated: (state, event) =>
    ours(state, event.key) && state.phase !== 'error' ? { ...state, replied: true } : state,
  stopped: (state, event) =>
    ours(state, event.key) && state.phase !== 'error' && state.phase !== 'done'
      ? { phase: 'done', key: event.key, stopped: true, replied: true }
      : state,
  finished: (state, event) =>
    ours(state, event.key) && state.phase !== 'error'
      ? { phase: 'done', key: event.key, replied: true }
      : state,
  note: (state, event) => noting(state, event.note),
}

const settle = (state: Settled, event: DockEvent): Settled =>
  (settling[event.type] as (state: Settled, event: DockEvent) => Settled)(state, event)

const meanwhile = (state: Recording, event: DockEvent): DockState => ({
  ...state,
  before: settle(state.before, event),
})

function stopped(state: Recording, event: Event<'stop'>): DockState {
  const { typed, before } = state
  if (event.retaking) {
    if (!event.spoke) return state
    const { typed: _taken, ...rest } = state
    return rest
  }
  if (event.spoke && event.collect)
    return typed ? { phase: 'sending', voice: true, typed } : noting(before, 'collecting')
  if (event.spoke) return { phase: 'sending', voice: true }
  if (event.paused) return noting(resumed(before), 'kept going')
  const back = quiet(before)
  return event.note ? noting(back, event.note) : back
}

const recording: Handlers<Recording, DockState> = {
  press: (state, event) => ({ ...state, busy: state.busy || event.busy }),
  open: (state) => ({ ...state, open: true }),
  enter: (state, event) => {
    const { typed: _replaced, ...rest } = state
    return event.typed ? { ...rest, typed: event.typed } : rest
  },
  cancel: (state, event) => (event.paused ? resumed(state.before) : quiet(state.before)),
  stop: stopped,
  ended: () => ({ phase: 'idle' }),
  abandon: meanwhile,
  interrupt: meanwhile,
  send: meanwhile,
  sent: meanwhile,
  failed: meanwhile,
  silent: meanwhile,
  words: meanwhile,
  playing: meanwhile,
  generated: meanwhile,
  stopped: meanwhile,
  finished: meanwhile,
  note: meanwhile,
}

export const transition = (state: DockState, event: DockEvent): DockState =>
  state.phase === 'recording'
    ? (recording[event.type] as (state: Recording, event: DockEvent) => DockState)(state, event)
    : event.type === 'press'
      ? { phase: 'recording', open: false, busy: event.busy, before: state }
      : settle(state, event)
