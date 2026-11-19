export type Phase =
  | 'exploring'
  | 'planning'
  | 'editing'
  | 'verifying'
  | 'fixing'
  | 'delegating'
  | 'wrapping_up'
type FirstRunInputSubmissionId = number

export type PhaseRow = {
  run?: FirstRunInputSubmissionId
  phase?: Phase
  confidence?: number
  at?: number
  pending?: number
  round?: number
  classifiedAt?: number
  due?: number
  tools?: string[]
}
export type PhaseState = { conversations: Record<string, PhaseRow> }
