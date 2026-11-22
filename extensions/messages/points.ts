import type { JSX } from '@solidjs/web'
import { definePoint } from '@/sdk/types.ts'
import type { Message } from './refs.ts'
import type { WaitFacts } from '../../lib/waits.ts'

export const WaitTimers = definePoint<null, WaitFacts['automations']>('messages.wait-timers')

export const MessageAnswers = definePoint<{ message: Message }, JSX.Element>('messages.answers')

export const MessageExtras = definePoint<{ message: Message }, JSX.Element>('messages.extras')
