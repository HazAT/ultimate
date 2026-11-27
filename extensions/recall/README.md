Recall brings a project memory back to @ultimate when a message calls for it, deep in a long context where the memory index from its start has faded. It needs `classify` (and so `TYPESAFE_API_KEY`); without it recall does nothing. The message text and every memory's one-line summary are sent to TypeSafe (see [classify](../classify/README.md)).

## When it runs

Before the first request after a new input to @ultimate, from the user (`pi.user`) or a branch (`board.message`), and only once @ultimate's context is at least 20% full (`conversations.context`). One classify `choice` asks which memory of @ultimate's root the message specifically calls for, with `none` as an option. Up to three memories at probability ≥ 0.25 are recalled; a memory recalled within the last 30% of the context window is skipped. Provider errors and the 3-second timeout leave the run unchanged.

## What it writes

A `recall.memories` entry right after the input: one user-role message with the recalled memories in full, and `{ input, root, memories: [{ slug, line, confidence }] }` as data. The entry lands after the running request's cutoff, so the hook also appends the same message to that request; later requests read it from storage at the same position, which keeps the cached prompt prefix. The system prompt never changes. `recall.state` on @ultimate's conversation keeps the input being checked (`pending`), the last input checked (`last`) and the context tokens at which each memory was last recalled (`injected`).

## What the user sees

While a message is checked, a band of light runs around its bubble's border (`userBubble` contribution), then fades. Recalled memories fly in under the bubble as chips; a chip opens the Memory surface on that memory. Nothing shows when no memory applies.

## Memory search

Recall also provides `lineage.memory-search`, which the `memory` tool's `query` uses: one classify `choice` over the root's memories with its own question (a coding agent searching its memory with a topic or situation), returning up to five memories at probability ≥ 0.15. The query text and every memory's one-line summary go to TypeSafe. Against 45 hand-written queries over 27 live memories it scored precision 0.97–1.00; recall was 0.97 on topic queries and 0.69 on situation queries, with no false picks on queries no memory covers. Recall's own question reached only 0.25 recall on situation queries. Broad queries spread probability across options and come back partial, so the tool asks for one topic per query.

## Tuning

The question and threshold were tuned once against 55 labelled messages from three chapters (the user's prompts, branch reports, casual lines such as "Good night!") and the project's live memories: precision 0.77, recall 0.62, quiet on 16 of 18 messages that called for no memory. Per-memory yes/no questions over-fired on habits that hold for every message; a single choice with `none` did not. Classify answers vary by up to 0.13 between calls, so borderline messages can flip; each input is asked once.
