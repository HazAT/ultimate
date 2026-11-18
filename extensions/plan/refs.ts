/**
 * The plan in the browser: a coordinator's epics and tasks, and the root's index of which child conversation works
 * on which task. Browser-safe.
 */
import type { ConversationId } from '@earendil-works/pi-durable'
import { docRef } from '../../shared/extension-api.ts'

/** One task of an epic; `child` is the conversation working on it. */
export type Task = {
  key: string
  title: string
  role: string
  description: string
  deps: string[]
  status: string
  child?: ConversationId
  verdict?: string
  notes: { at: string; text: string }[]
}
/**
 * One epic with its tasks by key; `met` lists the 1-based acceptance criteria the coordinator confirmed, and `revision`
 * counts the edits of its criteria.
 */
export type Epic = {
  key: string
  title: string
  body: string
  status: string
  verdict?: string
  met?: number[]
  revision?: number
  tasks: Record<string, Task>
}
/**
 * How far the work on one acceptance criterion looks, judged from the coordinator's recent tool calls; `at` is the entry
 * of the tool round that made it look done. An estimate, never a confirmation.
 */
export type Estimate = { state: 'in_progress' | 'looks_done'; at?: number }
/** Acceptance criteria at one landing of the coordinator's work: `confirmed` and `estimated` of `total`. */
export type Landed = { total: number; confirmed: number; estimated: number }
/** An epic's estimates by criterion text, and its criteria at each landing by lander submission id. */
export type EpicProgress = { estimates?: Record<string, Estimate>; landed?: Record<string, Landed> }
/** A coordinator's plan. */
export type Plan = { next: number; epics: Record<string, Epic> }
/** The plan task a child conversation works on, and whose plan it is in. */
export type TaskLink = {
  coordinator: ConversationId
  epic: string
  key: string
  title: string
  status: string
}

/** A coordinator's epics and tasks, on the coordinator's conversation. */
export const PlanDoc = docRef<Plan>('ultimate.plan')
/** `{ epics: { [key]: EpicProgress } }` on the coordinator's conversation: estimates and landings, outside plan history. */
export const ProgressDoc = docRef<{ epics: Record<string, EpicProgress> }>('ultimate.plan.progress')
/** `{ children: { [conversationId]: TaskLink } }` on conversation 1: every linked child's plan task. */
export const TaskIndexDoc = docRef<{ children: Record<string, TaskLink> }>('ultimate.plan.tasks')
