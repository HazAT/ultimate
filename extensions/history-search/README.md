# History search

Search the stored history of the conversations for where something was said or decided, and open the hit.

A full-screen surface with a keyboard-first input: it searches as typing settles, arrows move through the results,
and Enter or a click opens the hit at its entry (`Esc` closes the surface). The scope chips narrow the search to this
conversation (with the history it forked from), the whole project, or every project this instance knows; a hit read
from another project opens on that project's own instance. `limit` caps a search at 100 hits by default, 1000 at most.

The searching itself is codemode's — a case-sensitive substring over stored entry JSON, excerpted to about 200
characters around the match — reached through the `codemode` service's `search` and `searchProject`; this extension
only scopes it and needs codemode enabled. Action: `search` (`{ text, scope?, limit? }` → `{ hits, errors? }`, a hit
carries `{ conversation, id, kind, at?, excerpt, project?, url? }`, `errors` names projects that failed).
