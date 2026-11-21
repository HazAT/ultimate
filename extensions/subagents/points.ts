import type { ReactNode } from 'react'
import { definePoint } from '@/sdk/types.ts'

export const AgentMark = definePoint<{ name: string }, ReactNode>('subagents.mark')
