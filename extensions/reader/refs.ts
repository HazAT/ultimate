/** Reader in the browser: one markdown file, the checkout's markdown files, and each file's thread. Browser-safe. */
import type { ConversationId } from '@earendil-works/pi-durable'
import { actionRef, docRef } from '../../shared/extension-api.ts'

/** One file's thread: the branch its comments go to, the conversation it branched from, and the file as shown. */
export type Thread = { id: ConversationId; from: ConversationId; path: string }

/** A markdown file as read: shown relative to its root, known by its real absolute path; `mtime` in ms. */
export type ReadFile = { path: string; absolute: string; root: string; text: string; mtime: number }

/** The checkout's markdown files, newest first; `truncated` when there were more than the list holds. */
export type ReaderFiles = { files: { path: string; mtime: number }[]; truncated: boolean }

/** On the root conversation: each file's thread, by the file's real absolute path. */
export const ThreadsDoc = docRef<{ threads: Record<string, Thread> }>('reader.threads')

/**
 * User only: `{ path, conversation? }` → the markdown file (`.md`/`.markdown`, at most 2 MB). A relative path resolves
 * in `conversation`'s ready worktree of the project's repository, then the project root; an absolute one must lie
 * inside those. Throws on anything outside them after symlinks are resolved.
 */
export const ReadAction = actionRef<{ path: string; conversation?: ConversationId }, ReadFile>(
  'reader',
  'read',
)
/** User only: `{ conversation? }` → the markdown files Git tracks or would track in that checkout, newest first. */
export const FilesAction = actionRef<{ conversation?: ConversationId } | null, ReaderFiles>(
  'reader',
  'files',
)
/**
 * User only: `{ path, conversation }` → the file's thread, resolved as `read` does from `conversation`: the recorded
 * branch while it exists, else a new branch of `conversation` that delivers nothing yet; `started` says it is new.
 */
export const ThreadAction = actionRef<
  { path: string; conversation: ConversationId },
  Thread & { started: boolean }
>('reader', 'thread')
