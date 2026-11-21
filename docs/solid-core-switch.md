# Solid core switch — done

The migration moved Markdown (C1), the transcript (C2), the composer (C3), then the shell and sidebar (C4) to Solid 2.
C5 finished the switch: the core and every built-in extension now run on Solid. Built-in browser facets use
`web.solid.tsx` and contribute plain Solid components.

Existing React facets outside the repository still work on the frozen, lazily loaded compat layer. See
[React facets on a Solid core](extensions/react-compat.md) for what it supports and how to move a facet to Solid.
