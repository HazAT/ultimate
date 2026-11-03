import type { CommitPublication, Session } from '@earendil-works/pi-durable'

/**
 * Follow stored commits; returns the detach function. A listener here outlives nothing its Session does, so the
 * observation's end (close or failure) needs no handling.
 */
export function onCommit(session: Session, advance: (publication: CommitPublication) => void) {
  const observation = session.observeCommits({ advance, end: () => {} })
  return () => observation.detach()
}
