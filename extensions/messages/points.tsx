import type { ReactNode } from 'react'
import { definePoint } from '@/sdk'
import type { Message } from './refs.ts'
import type { WaitFacts } from '../../lib/waits.ts'

export const WaitTimers = definePoint<null, WaitFacts['automations']>('messages.wait-timers')

export const MessageAnswers = definePoint<Message, ReactNode>('messages.answers')
