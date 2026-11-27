import type { JSX } from '@solidjs/web'
import type { Component } from 'solid-js'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { definePoint } from '@/sdk/types.ts'
import type { Message } from './refs.ts'
import type { WaitFacts } from '../../lib/waits.web.ts'

export const WaitTimers = definePoint<null, WaitFacts['automations']>('messages.wait-timers')

export const MessageAnswers = definePoint<{ message: Message }, JSX.Element>('messages.answers')

export const MessageExtras = definePoint<{ message: Message }, JSX.Element>('messages.extras')

export const ExternalSpeaker = definePoint<
  EntryRecord,
  { name: string; title: string; model?: string; icon?: Component<{ class?: string }> } | undefined
>('messages.external-speaker')
