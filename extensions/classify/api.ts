/**
 * Classify: typed judgments (choice, yes/no, score) over JSON state from TypeSafe's models, for extensions that need a
 * cheap structured verdict instead of a chat completion.
 */
import type { JsonValue } from '@earendil-works/chord/json'
import { defineApi } from '../../shared/extension-api.ts'

/** One question: its instructions and the criteria for each choice, outcome or score. */
export type ClassifyQuestion =
  | { type: 'choice'; instructions: JsonValue; criteria: Record<string, JsonValue> }
  | { type: 'noul'; instructions: JsonValue; criteria?: { true?: JsonValue; false?: JsonValue } }
  | { type: 'score'; instructions: JsonValue; criteria: JsonValue[] }

/** The answer to one question, with its confidence. */
export type ClassifyAnswer =
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'noul'; noul: number }
  | {
      type: 'score'
      score: number
      confidence: number
      probabilities: Record<string, number>
      legend: Record<string, JsonValue>
    }

/** Every answer by question id, the model that gave them and the input tokens used. */
export type ClassifyResult = {
  model: string
  answers: Record<string, ClassifyAnswer>
  usage: { inputTokens: number }
}

export type ClassifyService = {
  /** Answer `questions` about `state` in one request; throws without `TYPESAFE_API_KEY` or on a malformed response. */
  ask(
    request: { state: JsonValue; questions: Record<string, ClassifyQuestion> },
    signal: AbortSignal,
  ): Promise<ClassifyResult>
}

/** Typed judgments over JSON state; `want` it, since classify is optional and needs a TypeSafe key. */
export const ClassifyApi = defineApi<ClassifyService>()('classify')
