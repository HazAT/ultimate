let context: AudioContext | undefined

function tone(frequency: number, seconds: number, gain: number, type: OscillatorType, delay = 0) {
  context ??= new AudioContext()
  const at = context.currentTime + delay
  const oscillator = context.createOscillator()
  const volume = context.createGain()
  oscillator.type = type
  oscillator.frequency.value = frequency
  volume.gain.setValueAtTime(0, at)
  volume.gain.linearRampToValueAtTime(gain, at + 0.01)
  volume.gain.exponentialRampToValueAtTime(0.0001, at + seconds)
  oscillator.connect(volume).connect(context.destination)
  oscillator.start(at)
  oscillator.stop(at + seconds + 0.02)
}

const pentatonic = [523.3, 587.3, 659.3, 784, 880, 1046.5, 1174.7, 1318.5]

export function createCues(enabled: () => boolean) {
  const play = (sound: () => void) => {
    if (enabled()) sound()
  }
  return {
    press: () => play(() => (tone(660, 0.08, 0.05, 'sine'), tone(880, 0.1, 0.04, 'sine', 0.06))),
    send: () => play(() => (tone(880, 0.08, 0.05, 'sine'), tone(660, 0.12, 0.04, 'sine', 0.06))),
    steer: () => play(() => (tone(740, 0.06, 0.05, 'sine'), tone(740, 0.06, 0.04, 'sine', 0.09))),
    stage: (index: number) =>
      play(() => tone(pentatonic[index % pentatonic.length], 0.12, 0.015, 'triangle')),
    thinking: () => play(() => tone(392, 0.25, 0.014, 'sine')),
    firstWord: () => play(() => tone(1046, 0.18, 0.035, 'triangle')),
    handoff: () => play(() => tone(330, 0.09, 0.05, 'triangle')),
    done: () => play(() => (tone(523, 0.12, 0.035, 'sine'), tone(784, 0.2, 0.035, 'sine', 0.1))),
    error: () => play(() => tone(220, 0.3, 0.05, 'square')),
  }
}
