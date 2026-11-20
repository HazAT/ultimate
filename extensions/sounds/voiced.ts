let questionsVoiced = false
export const voiceQuestions = (on: boolean) => {
  questionsVoiced = on
}
export const questionsSpoken = () => questionsVoiced
