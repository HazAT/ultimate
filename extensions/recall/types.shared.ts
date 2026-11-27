import { defineEntry } from '@earendil-works/pi-durable'

export const RecalledEntry = defineEntry<Recalled>('recall.memories')

export type Recalled = {
  input: number
  root: number
  memories: { slug: string; line: string; confidence: number }[]
}
