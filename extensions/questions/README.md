# Questions

Answer cards for @ultimate's questions to the user. One thing asks: a reply-expected message to the user that carries
`questions`. @ultimate's `message { to: 'user', text, questions }` declares them; messages validates them at the tool
boundary (`extensions/messages/questions.ts`) and stores them on the message, and the card renders exactly what was
declared. No model reads the text, and nothing is extracted. Final answers never ask: @ultimate's instructions put
every decision in such a message.

```ts
type Question = {
  text: string
  kind: 'choice' | 'multi' | 'confirm' | 'text' | 'scale'
  ref?: string // the message's own number, "2"
  options?: {
    label: string
    key?: string
    detail?: string
    recommended?: boolean
    preview?: string
  }[]
  scale?: { min: number; max: number; low?: string; high?: string }
  placeholder?: string
}
```

The tool refuses, naming the question: no questions, a choice or multi with fewer than two options or repeated labels
or keys, an option that is "Something else"/"Other" (the card adds it), a scale without an ascending range of at most
10 steps, and repeated question texts or refs. Fields that do not apply to a kind are dropped, text is trimmed.
`questions` goes only with a reply-expected message to `user`.

A question stays open until the user answers it (its card, or a Reply to that message) or dismisses it. Typed input,
answers to other messages and agent messages leave it open. While it is open, messages starts each of the asker's runs
with a line listing it by its questions (see [Messages](../messages/README.md)).

## Card

Under the outgoing `message` card in @ultimate's transcript, through messages’ `MessageAnswers` point. One question is
open at a time; the others fold to a line with their answer (`1b drop them`) or “not answered”, and a dot per question
shows progress. Kinds: `choice` (one option), `multi` (any), `confirm` (Yes/No), `scale` (numbered steps with end
labels) and `text` (a field); options offer “Something else…” with an inline field, and an option's Markdown `preview`
shows beside the options for the hovered or chosen one. Recommended options carry a “my pick” chip. Under the questions,
a note field is always there: whatever it holds goes after the answer lines, or on its own (“Send note”), and never
changes a pick. **Accept picks** chooses every pick still open; Send sends what is answered (“Send 2 of 5”). With
questions left unanswered, a note on its own included, Send first asks in place of the buttons, “2 of 5 answered: send
anyway?”: **Send anyway** (Enter, or sending again) sends, **Keep editing** (Esc) opens the first unanswered question,
and changing an answer closes the ask. Sending
opens a 3 s window with Undo before the answer goes out, then the card settles into the summary of what was sent, the
note on its own line. Dismiss closes the message without an answer. A message without questions gets a one-line answer
field (sent as a Reply to that message) and Dismiss. On desktop, 1–9 or an option's letter (`y`/`n` for Yes/No, `o`
for Something else) chooses, ↑/↓ moves between questions, Enter takes the open question's pick or goes to the next,
and sends from the last one; ⇧Enter accepts every pick and sends; `/` focuses the note field, where Enter sends and
⇧Enter breaks a line; Esc clears an answer, leaves the note field or, while sending, undoes. Only the shown
conversation's newest open card takes these keys; they leave alone input/textarea editing and keys pressed in another
card, on another control or in the panel, whose cards take no global keys.

## Where open questions wait

The To-dos tab lists every message that waits on the user at its top, newest first, named by its first question; a
row opens the asking conversation at the message, where this card answers or dismisses it. ⌘K “Show open
questions” opens the tab; meanwhile @ultimate's mark is amber.

## Actions

Both are user-only.

- `answer { messageId, answers: [{ question, answer }], note? }` validates against the message's questions, refusing
  unknown or duplicate answers, and posts a normal user reply to the sender with `re: messageId`, one paragraph per
  answer in the message's own numbering: `1a. Topic: option` for an option, `2a,c. Topic: a, c` for several (a multi
  answer joins its labels with ", "), `3: text` for typed text or a rating (`Topic: answer` when the message numbered
  nothing), then `Note: …`; with no answers the note alone is the reply. Returns `{ id }`. `answer { messageId, text }`
  posts `text` instead, for a message with or without questions. Messages admission atomically verifies that the
  original remains open, so concurrent answers produce exactly one reply; normal Messages delivery wakes the sender.
- `dismiss { messageId }` marks the message `dismissed` and posts a one-way user note to the sender with `re`, in one
  commit, returning `{ id }`. The note reaches the sender as a note: it reads it with its next input, and no run
  starts. A message that is no longer open is refused.

Messages asked before questions were declared (their cards came from a `questions.board` document, now gone) keep
the plain answer field. Retired transcript question and answer entries are hidden rather than exposing their raw JSON.
