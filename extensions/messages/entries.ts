import { defineEntry } from '@earendil-works/pi-durable'
import type { QuestionNotice } from './refs.ts'

export const AskedEntry = defineEntry<QuestionNotice>('board.asked')

export const AnsweredEntry = defineEntry<QuestionNotice>('board.answered')
