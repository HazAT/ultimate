export type GeminiUsage = {
  promptTokenCount: number
  candidatesTokenCount: number
  cachedContentTokenCount?: number
  thoughtsTokenCount?: number
  totalTokenCount: number
}

export type RemoteFile = { name: string; uri: string; expiresAt: number; active?: boolean }

export type AskResult = { answer: string; usage: GeminiUsage; model: string }
