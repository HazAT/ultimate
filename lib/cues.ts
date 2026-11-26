let context: AudioContext | undefined

export function tone(
  frequency: number,
  seconds: number,
  gain: number,
  type: OscillatorType,
  delay = 0,
) {
  if (typeof AudioContext === 'undefined') return
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

export const startCue = () => (tone(660, 0.08, 0.05, 'sine'), tone(880, 0.1, 0.04, 'sine', 0.06))
export const stopCue = () => (tone(880, 0.08, 0.05, 'sine'), tone(660, 0.12, 0.04, 'sine', 0.06))
