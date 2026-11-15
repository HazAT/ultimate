/** Typed transcript entries written by this extension. Browser-safe. */
import { defineEntry } from '@earendil-works/pi-durable'
import type { QuestionNotice } from './refs.ts'

/** A question opened. */
export const AskedEntry = defineEntry<QuestionNotice>('board.asked')

/** A question settled. */
export const AnsweredEntry = defineEntry<QuestionNotice>('board.answered')
