A temporary surface that shows how far the Solid 2 + UI SDK front-end migration has come: lines, bundle size,
conversation switching and streaming re-renders at every step against pure React, and which extensions are React,
partly moved or Solid.

The series comes from `docs/frontend-progress.json` (one entry per measured commit, written by the measurement
scripts); each step's coordinator comes from its commit's `Ultimate-Conversation` trailer. The per-extension split is
counted from the working tree on every read, the same way `scripts/frontend-weight.ts` counts lines.

Delete this folder when the migration is done.
