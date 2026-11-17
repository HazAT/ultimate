import type { CommitPublication, Session } from '@earendil-works/pi-durable'

export function onCommit(session: Session, advance: (publication: CommitPublication) => void) {
  const observationEndsWithSession = () => {}
  const observation = session.observeCommits({ advance, end: observationEndsWithSession })
  return () => observation.detach()
}
