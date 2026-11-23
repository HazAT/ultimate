import * as Tone from 'tone'
import { deadline, pace } from '../../lib/timers.ts'
import type { Cancel } from '../../lib/timers.ts'
import type { Sound } from './cues.ts'
import type { Happening, Role, Tool } from './agents.ts'
import type { Variant } from './variants.ts'

const limitedMaster = new Tone.Volume(-6)
limitedMaster.chain(new Tone.Limiter(-3), Tone.getDestination())
const reverb = new Tone.Reverb({ decay: 3.5, wet: 0.28 }).connect(limitedMaster)

export function setVolume(gain01: number) {
  limitedMaster.mute = gain01 <= 0
  limitedMaster.volume.rampTo(Tone.gainToDb(gain01) - 6, 0.05)
}

const reverbTailSeconds = 5
let bandPlaying = false
let cancelRest: Cancel | undefined
let quietAtAudioSeconds = 0

function tick() {
  cancelRest?.()
  cancelRest = undefined
  if (Tone.getContext().clockSource !== 'worker') Tone.getContext().clockSource = 'worker'
}

function restAfter(seconds: number) {
  quietAtAudioSeconds = Math.max(quietAtAudioSeconds, Tone.now() + seconds)
  cancelRest?.()
  cancelRest = bandPlaying ? undefined : deadline(seconds * 1000, rest)
}

function rest() {
  const audioStillDue = quietAtAudioSeconds - Tone.now()
  const contextCanStillPlay = Tone.getContext().state !== 'suspended'
  if (audioStillDue > 0 && contextCanStillPlay) {
    cancelRest = deadline(audioStillDue * 1000, rest)
    return
  }
  cancelRest = undefined
  Tone.getContext().clockSource = 'offline'
  ;(Tone.getContext().rawContext as AudioContext)
    .suspend()
    .catch((error: unknown) => console.warn('Audio suspend failed', error))
}
rest()

export const unlock = async () => {
  tick()
  await Tone.start()
  restAfter(reverbTailSeconds)
}
export const running = () => Tone.getContext().state === 'running'

const hz = (midi: number) => Tone.mtof(midi as Tone.Unit.MidiNote)

type Strike = readonly [
  startSeconds: number,
  simultaneousMidiNotes: readonly number[],
  velocity: number,
]

const shortCueRoom = new Tone.Reverb({ decay: 0.7, wet: 0.14 }).connect(limitedMaster)

const kalimba = new Tone.PolySynth(Tone.FMSynth, {
  harmonicity: 7.02,
  modulationIndex: 2.2,
  oscillator: { type: 'sine' },
  envelope: { attack: 0.001, decay: 0.42, sustain: 0, release: 0.25 },
  modulation: { type: 'sine' },
  modulationEnvelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.05 },
}).connect(shortCueRoom)
kalimba.volume.value = -4

const gMajorCues: Record<Sound, Strike[]> = {
  input: [
    [0, [74], 0.6],
    [0.11, [79], 0.7],
  ],
  finished: [
    [0, [86], 0.55],
    [0.09, [83], 0.55],
    [0.18, [79], 0.7],
  ],
  landed: [
    [0, [86], 0.55],
    [0.09, [83], 0.55],
    [0.18, [79], 0.7],
    [0.18, [67], 0.5],
    [0.36, [91], 0.3],
  ],
  failed: [
    [0, [74], 0.5],
    [0.15, [70], 0.55],
  ],

  started: [[0, [79], 0.45]],
}

function strike(tune: Sound, time: number) {
  for (const [start, notes, velocity] of gMajorCues[tune])
    kalimba.triggerAttackRelease(notes.map(hz), 0.12, time + start, velocity)
}

export async function play(sound: Sound) {
  await unlock()
  strike(sound, Tone.now() + 0.03)
}

const voiceLeadInSeconds = 0.45

export async function say(sound: Sound, text: string, mono24kHzPcm16: ArrayBuffer | undefined) {
  await unlock()
  const now = Tone.now() + 0.03
  strike(sound, now)
  if (!mono24kHzPcm16) {
    await pace(voiceLeadInSeconds * 1000)
    const utterance = new SpeechSynthesisUtterance(text)
    await new Promise((resolve) => {
      utterance.addEventListener('end', resolve)
      utterance.addEventListener('error', resolve)
      speechSynthesis.speak(utterance)
    })
    return
  }
  const samples = new Int16Array(mono24kHzPcm16)
  const buffer = Tone.getContext().createBuffer(1, samples.length, 24000)
  const wave = buffer.getChannelData(0)
  for (let i = 0; i < samples.length; i++) wave[i] = samples[i] / 32768
  const voice = new Tone.Player(buffer).connect(limitedMaster)
  voice.onstop = () => voice.dispose()
  voice.start(now + voiceLeadInSeconds)
  restAfter(voiceLeadInSeconds + buffer.duration + reverbTailSeconds)
  await pace((voiceLeadInSeconds + buffer.duration) * 1000)
}

const dMajorIviIVV = [
  [50, 54, 57],
  [47, 50, 54],
  [43, 47, 50],
  [45, 49, 52],
]
const pentatonic = [0, 2, 4, 7, 9]

const pentatonicD = (degree: number, base = 62) =>
  base + Math.floor(degree / 5) * 12 + pentatonic[((degree % 5) + 5) % 5]

const octaveChordTone = (chord: readonly number[], index: number) =>
  chord[((index % 3) + 3) % 3] + 12 * Math.floor(index / 3)

const roleContours: Record<Role, readonly number[]> = {
  ultimate: [0, 2, 1, 2],
  coordinator: [0, 1, 2, 1],
  worker: [0, 1, 2, 3, 2, 1],
  scout: [3, 2, 1, 2],
  reviewer: [2, 1, 0, 1],
  lander: [0, 0, 1, 2],
  other: [0, 1, 0, 2],
}
function walkRoleContour() {
  const at: Partial<Record<Role, number>> = {}
  return (role: Role) => {
    const index = at[role] ?? 0
    at[role] = index + 1
    return roleContours[role][index % roleContours[role].length]
  }
}

function laterVoiceStart() {
  let last = 0
  return (time: number) => (last = Math.max(time, last + 0.012))
}

type Part = {
  fixedBpm: number
  hitsPerSixteenth: number
  play: (happening: Happening, time: number, bar: number) => void
  decayEffects?: (time: number) => void
  nodes: Tone.ToneAudioNode[]
}

export type Band = {
  hit: (happening: Happening) => void
  dispose: () => void
}

export function band(variant: Variant): Band {
  const part = parts[variant]()
  const queue: Happening[] = []
  let step = 0
  const transport = Tone.getTransport()
  bandPlaying = true
  tick()

  transport.bpm.value = part.fixedBpm
  const loop = new Tone.Loop((time) => {
    const bar = Math.floor(step / 16)

    const staleTick = time < Tone.now() - 0.1
    if (staleTick) queue.length = 0
    for (const happening of queue.splice(0, part.hitsPerSixteenth)) part.play(happening, time, bar)

    const queuedStepLimit = 8
    queue.splice(0, Math.max(0, queue.length - part.hitsPerSixteenth * queuedStepLimit))
    part.decayEffects?.(time)
    step++
  }, '16n').start(0)
  transport.start('+0.05')
  return {
    hit: (happening) => void queue.push(happening),
    dispose: () => {
      loop.dispose()
      transport.stop()
      transport.cancel()

      const releaseTailMs = 12_000
      deadline(releaseTailMs, () => {
        for (const node of part.nodes) node.dispose()
      })
      bandPlaying = false
      restAfter(releaseTailMs / 1000)
    },
  }
}

const parts: Record<Variant, () => Part> = {
  chiptune,
  orchestra,
  crazy,
}

type Phrase = readonly (readonly [
  startSixteenths: number,
  midiNote: number,
  lengthSixteenths: number,
  velocity?: number,
])[]

function monoChannel(
  sound: (midi: number, seconds: number, time: number, velocity: number) => void,
) {
  let freeAtSeconds = 0
  return (phrase: Phrase, time: number, mustPlay = false) => {
    const sixteenth = Tone.Time('16n').toSeconds()
    const start = Math.max(time, freeAtSeconds)
    const dropLatePhrase = !mustPlay && start > time + sixteenth * 4
    if (dropLatePhrase) return
    let end = start
    for (const [at, midi, steps, velocity = 0.7] of phrase) {
      sound(midi, steps * sixteenth * 0.85, start + at * sixteenth, velocity)
      end = Math.max(end, start + (at + steps) * sixteenth)
    }
    freeAtSeconds = end
  }
}

function chiptune(): Part {
  const bus = new Tone.Volume(-10)
  bus.chain(new Tone.Filter(7000, 'lowpass'), limitedMaster)
  const pulse = (width: number) =>
    new Tone.Synth({
      oscillator: { type: 'pulse', width },
      envelope: { attack: 0.002, decay: 0.12, sustain: 0.45, release: 0.05 },
    }).connect(bus)

  const quarterDutyWidth = 0.5
  const squareWidth = 0
  const lead = pulse(quarterDutyWidth)
  const second = pulse(squareWidth)
  second.volume.value = -4
  const triangle = new Tone.Synth({
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.002, decay: 0.05, sustain: 0.9, release: 0.03 },
  }).connect(bus)
  triangle.volume.value = 2
  const noise = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.07, sustain: 0 },
  }).connect(bus)
  noise.volume.value = -8
  const note =
    (synth: Tone.Synth) => (midi: number, seconds: number, time: number, velocity: number) =>
      synth.triggerAttackRelease(hz(midi), seconds, time, velocity)
  const ch = {
    lead: monoChannel(note(lead)),
    second: monoChannel(note(second)),
    triangle: monoChannel(note(triangle)),

    noise: monoChannel((thudOrTickMidi, seconds, time, velocity) =>
      noise.triggerAttackRelease(
        Math.min(seconds, thudOrTickMidi > 60 ? 0.03 : 0.12),
        time,
        velocity,
      ),
    ),
  }

  const octave: Record<Role, number> = {
    ultimate: 12,
    coordinator: 0,
    worker: 12,
    scout: 24,
    reviewer: 12,
    lander: 12,
    other: 24,
  }
  const step = walkRoleContour()
  return {
    fixedBpm: 150,
    hitsPerSixteenth: 2,
    nodes: [lead, second, triangle, noise, bus],
    play: (h, time, bar) => {
      const chord = dMajorIviIVV[bar % 4]
      if (h.kind === 'tool') {
        const at = step(h.role)
        const n = octaveChordTone(chord, at) + octave[h.role] + 12

        if (h.tool === 'edit' || h.tool === 'other')
          ch.lead(
            [
              [0, n, 0.5, 0.35],
              [0.5, octaveChordTone(chord, at + 1) + octave[h.role] + 12, 1, 0.35],
            ],
            time,
          )
        else if (h.tool === 'bash') {
          ch.noise([[0, 30, 1, 0.5]], time)
          ch.triangle([[0, chord[0] - 12, 1, 0.8]], time)
        } else if (h.tool === 'read') ch.second([[0, n, 0.5, 0.25]], time)
        else
          ch.second(
            [0, 1, 2].map(
              (i) => [i * 0.5, octaveChordTone(chord, i) + octave[h.role] + 12, 0.5, 0.3] as const,
            ),
            time,
          )
        return
      }
      if (h.kind === 'start') {
        const base = octave[h.role] + 12
        ch.second(
          [0, 1, 2, 1, 3, 4].map(
            (i, at) => [at, octaveChordTone(chord, i) + base, 1, 0.4] as const,
          ),
          time,
        )
      } else if (h.kind === 'stop')
        ch.second(
          [
            [0, chord[2] + octave[h.role] + 12, 1, 0.3],
            [1, chord[0] + octave[h.role] + 12, 2, 0.3],
          ],
          time,
        )
      else if (h.kind === 'commit')
        ch.lead(
          [
            [0, 81, 0.75, 0.6],
            [0.75, 86, 5, 0.6],
          ],
          time,
          true,
        )
      else if (h.kind === 'landed') {
        strike('landed', time)
      } else {
        ch.noise([[0, 30, 2, 0.9]], time, true)
        ch.lead(
          [
            [0, 70, 1, 0.55],
            [1, 69, 1, 0.55],
            [2, 68, 4, 0.55],
          ],
          time,
          true,
        )
        ch.triangle(
          [
            [0, 50, 1],
            [2, 38, 4],
          ],
          time,
          true,
        )
      }
    },
  }
}

function orchestra(): Part {
  const hall = new Tone.Reverb({ decay: 4, wet: 0.35 }).connect(limitedMaster)

  const strings = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'fatsawtooth', count: 3, spread: 20 },
    envelope: { attack: 0.6, decay: 0.4, sustain: 0.7, release: 2 },
  })
  strings.chain(new Tone.Filter(1200, 'lowpass'), hall)
  strings.volume.value = -22

  const cello = new Tone.MonoSynth({
    oscillator: { type: 'sawtooth' },
    filter: { Q: 1, type: 'lowpass' },
    envelope: { attack: 0.05, decay: 0.3, sustain: 0.5, release: 0.8 },
    filterEnvelope: { attack: 0.05, decay: 0.4, sustain: 0.4, baseFrequency: 120, octaves: 2.5 },
  }).connect(hall)
  cello.volume.value = -14

  const pluck = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.003, decay: 0.35, sustain: 0, release: 0.4 },
  }).connect(hall)
  pluck.volume.value = -10

  const flute = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'sine' },
    envelope: { attack: 0.06, decay: 0.2, sustain: 0.6, release: 0.5 },
  })
  flute.connect(new Tone.Vibrato(5, 0.08).connect(hall))
  flute.volume.value = -16

  const marimba = new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 4,
    modulationIndex: 3,
    envelope: { attack: 0.001, decay: 0.5, sustain: 0, release: 0.5 },
    modulationEnvelope: { attack: 0.001, decay: 0.15, sustain: 0, release: 0.2 },
  }).connect(hall)
  marimba.volume.value = -10

  const brass = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'fatsawtooth', count: 2, spread: 10 },
    envelope: { attack: 0.08, decay: 0.3, sustain: 0.6, release: 0.6 },
  })
  brass.chain(new Tone.Filter(1800, 'lowpass'), hall)
  brass.volume.value = -14
  const timpani = new Tone.MembraneSynth({ pitchDecay: 0.08, octaves: 3 }).connect(hall)
  timpani.volume.value = -12
  const t = { cello: laterVoiceStart(), timpani: laterVoiceStart() }
  const voice: Record<Role, { synth: Tone.PolySynth | Tone.MonoSynth; octave: number }> = {
    ultimate: { synth: strings, octave: 12 },
    coordinator: { synth: cello, octave: -12 },
    worker: { synth: pluck, octave: 12 },
    scout: { synth: flute, octave: 24 },
    reviewer: { synth: marimba, octave: 24 },
    lander: { synth: brass, octave: 12 },
    other: { synth: pluck, octave: 24 },
  }

  const figures: Record<Tool, { notes: number[]; length: string; velocity: number }> = {
    bash: { notes: [0], length: '16n', velocity: 0.8 },
    edit: { notes: [0, 2], length: '16n', velocity: 0.7 },
    read: { notes: [2], length: '8n', velocity: 0.35 },
    browser: { notes: [0, 1, 2], length: '32n', velocity: 0.55 },
    other: { notes: [1], length: '16n', velocity: 0.5 },
  }
  const step = walkRoleContour()
  const sound = (role: Role, midi: number, length: string, time: number, velocity: number) => {
    const { synth } = voice[role]
    if (synth === cello) cello.triggerAttackRelease(hz(midi), length, t.cello(time), velocity)
    else (synth as Tone.PolySynth).triggerAttackRelease(hz(midi), length, time, velocity)
  }
  return {
    fixedBpm: 96,
    hitsPerSixteenth: 3,
    nodes: [strings, cello, pluck, flute, marimba, brass, timpani, hall],
    play: (h, time, bar) => {
      const chord = dMajorIviIVV[bar % 4]
      const sixteenth = Tone.Time('16n').toSeconds()
      if (h.kind === 'tool') {
        const { octave } = voice[h.role]
        const figure = figures[h.tool]
        const low = h.tool === 'bash' ? -12 : 0

        const from = step(h.role)
        figure.notes.forEach((offset, index) =>
          sound(
            h.role,
            octaveChordTone(chord, from + offset) + octave + low,
            figure.length,
            time + index * sixteenth,
            figure.velocity,
          ),
        )
      } else if (h.kind === 'start')
        chord.forEach((midi, index) =>
          sound(h.role, midi + voice[h.role].octave, '8n', time + index * sixteenth * 2, 0.6),
        )
      else if (h.kind === 'stop') {
        sound(h.role, chord[2] + voice[h.role].octave, '8n', time, 0.4)
        sound(h.role, chord[0] + voice[h.role].octave, '4n', time + sixteenth * 2, 0.35)
      } else if (h.kind === 'commit') {
        timpani.triggerAttackRelease(hz(38), '8n', t.timpani(time), 0.7)
        marimba.triggerAttackRelease(hz(85), '16n', time, 0.5)
        marimba.triggerAttackRelease([74, 78, 81].map(hz), '8n', time + sixteenth, 0.6)
      } else if (h.kind === 'landed') strike('landed', time)
      else {
        brass.triggerAttackRelease([55, 58, 61, 64].map(hz), '8n', time, 0.8)
        timpani.triggerAttackRelease(hz(36), '4n', t.timpani(time), 0.9)
      }
    },
  }
}

function crazy(): Part {
  const crush = new Tone.BitCrusher(8)
  const echo = new Tone.FeedbackDelay({ delayTime: '8n', feedback: 0.3, wet: 0.18 })
  const bus = new Tone.Volume(-4)
  bus.chain(crush, echo, reverb)
  crush.wet.value = 0.35
  const snare = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.15, sustain: 0 },
  }).connect(bus)
  snare.volume.value = -10
  const hat = new Tone.MetalSynth({
    harmonicity: 5.1,
    modulationIndex: 32,
    resonance: 4000,
    octaves: 1.5,
    envelope: { attack: 0.001, decay: 0.05, release: 0.01 },
  }).connect(bus)
  hat.volume.value = -26
  const crash = new Tone.MetalSynth({
    harmonicity: 3.1,
    modulationIndex: 16,
    resonance: 3000,
    envelope: { attack: 0.001, decay: 1.4, release: 0.5 },
  }).connect(bus)
  crash.volume.value = -22
  const acid = new Tone.MonoSynth({
    oscillator: { type: 'sawtooth' },
    filter: { Q: 8, type: 'lowpass' },
    envelope: { attack: 0.005, decay: 0.15, sustain: 0.2, release: 0.1 },
    filterEnvelope: { attack: 0.005, decay: 0.12, sustain: 0.1, baseFrequency: 180, octaves: 4 },
  }).connect(bus)
  acid.volume.value = -14
  const zap = new Tone.FMSynth({
    harmonicity: 8,
    modulationIndex: 20,
    envelope: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.05 },
    modulationEnvelope: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.05 },
  }).connect(bus)
  zap.volume.value = -14
  const stab = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'fatsquare', count: 3, spread: 30 },
    envelope: { attack: 0.002, decay: 0.2, sustain: 0.1, release: 0.3 },
  })
  stab.chain(new Tone.Distortion(0.4), bus)
  stab.volume.value = -18
  const riser = new Tone.NoiseSynth({
    noise: { type: 'pink' },
    envelope: { attack: 0.6, decay: 0.05, sustain: 0 },
  })
  const sweep = new Tone.Filter(400, 'bandpass')
  riser.chain(sweep, bus)
  riser.volume.value = -18
  const t = {
    snare: laterVoiceStart(),
    hat: laterVoiceStart(),
    crash: laterVoiceStart(),
    acid: laterVoiceStart(),
    zap: laterVoiceStart(),
    riser: laterVoiceStart(),
  }
  let glitch = 0

  const rootRiffOffsets = [0, 12, 7, 0, 10, 12]
  let edits = 0
  const step = walkRoleContour()
  return {
    fixedBpm: 128,
    hitsPerSixteenth: 4,
    nodes: [snare, hat, crash, acid, zap, stab, riser, sweep, crush, echo, bus],
    play: (h, time, bar) => {
      if (h.kind === 'tool') {
        if (h.tool === 'bash') snare.triggerAttackRelease('16n', t.snare(time), 0.6)
        else if (h.tool === 'edit')
          acid.triggerAttackRelease(
            hz(dMajorIviIVV[bar % 4][0] - 12 + rootRiffOffsets[edits++ % rootRiffOffsets.length]),
            '16n',
            t.acid(time),
            0.9,
          )
        else if (h.tool === 'read') hat.triggerAttackRelease(hz(400), '32n', t.hat(time), 0.9)
        else
          zap.triggerAttackRelease(hz(pentatonicD(step(h.role) + 2, 74)), '32n', t.zap(time), 0.9)

        glitch = Math.min(1, glitch + 0.08)
      } else if (h.kind === 'start') {
        sweep.frequency.setValueAtTime(300, time)
        sweep.frequency.exponentialRampToValueAtTime(5000, time + 0.6)
        riser.triggerAttackRelease(0.6, t.riser(time), 0.7)
      } else if (h.kind === 'stop') zap.triggerAttackRelease(hz(38), '16n', t.zap(time), 0.7)
      else if (h.kind === 'commit') {
        crash.triggerAttackRelease(hz(300), '8n', t.crash(time), 0.6)
        stab.triggerAttackRelease([62, 66, 69].map(hz), '16n', time, 0.6)
      } else if (h.kind === 'landed') strike('landed', time)
      else {
        crush.bits.setValueAtTime(3, time)
        crush.bits.linearRampToValueAtTime(8, time + 1.2)
        stab.triggerAttackRelease([49, 50, 55, 56].map(hz), '8n', time, 0.9)
        for (let i = 0; i < 4; i++) snare.triggerAttackRelease('64n', t.snare(time + i * 0.06), 0.9)
      }
    },

    decayEffects: (time) => {
      glitch *= 0.97
      crush.wet.setValueAtTime(0.25 + glitch * 0.6, time)
    },
  }
}
