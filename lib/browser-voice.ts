export function browserVoice(text: string, rate: number, ended: () => void) {
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.rate = rate
  utterance.addEventListener('end', ended)
  utterance.addEventListener('error', ended)
  speechSynthesis.speak(utterance)
  return utterance
}
