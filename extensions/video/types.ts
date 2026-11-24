import type { GeminiUsage } from '../antigravity/api.ts'

export type AskResult = { answer: string; usage: GeminiUsage; model: string }
