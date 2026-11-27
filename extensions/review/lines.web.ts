import type { FileDiffMetadata, SelectedLineRange } from '@pierre/diffs'
import { excerptOf } from './comments.shared.ts'
import type { ReviewComment } from './comments.shared.ts'

const strip = (line: string | undefined) => (line ?? '').replace(/\r?\n$/, '')

export function linesOf(diff: FileDiffMetadata) {
  const old = new Map<number, string>()
  const next = new Map<number, string>()
  for (const hunk of diff.hunks) {
    let oldLine = hunk.deletionStart
    let newLine = hunk.additionStart
    for (const part of hunk.hunkContent) {
      if (part.type === 'context')
        for (let index = 0; index < part.lines; index++) {
          old.set(oldLine++, strip(diff.deletionLines[part.deletionLineIndex + index]))
          next.set(newLine++, strip(diff.additionLines[part.additionLineIndex + index]))
        }
      else {
        for (let index = 0; index < part.deletions; index++)
          old.set(oldLine++, strip(diff.deletionLines[part.deletionLineIndex + index]))
        for (let index = 0; index < part.additions; index++)
          next.set(newLine++, strip(diff.additionLines[part.additionLineIndex + index]))
      }
    }
  }
  return { old, new: next }
}

export type CommentLines = Pick<ReviewComment, 'file' | 'side' | 'start' | 'end'>

export function commentRange(diff: FileDiffMetadata, range: SelectedLineRange): CommentLines {
  const selectionEndSide = range.endSide ?? range.side
  return {
    file: diff.name,
    side: selectionEndSide === 'deletions' ? 'old' : 'new',
    start: Math.min(range.start, range.end),
    end: Math.max(range.start, range.end),
  }
}

export function excerptFor(diff: FileDiffMetadata | undefined, comment: CommentLines) {
  if (!diff) return ''
  const lines = linesOf(diff)[comment.side]
  const shown: string[] = []
  for (let line = comment.start; line <= comment.end; line++) {
    const text = lines.get(line)
    if (text !== undefined) shown.push(text)
  }
  return excerptOf(shown)
}
