# Sketch

Agents show the user a small UI (a chart, a table, metrics, a form) by describing it in words; a fast model draws it.

`sketch { request, data? }` asks the summary model (the `tiny` family unless `summaryModel` pins another) to call one
tool, `render`, whose arguments are the spec: up to six blocks of `text` (Markdown), `metric`, `chart` (bar or line, up
to four series), `table`, `form`, or a `row` of two or three of those side by side. pi-ai validates the arguments
against the schema in `server.ts`; an invalid spec goes back to the model once with the errors, and a second invalid
one fails the call. With `data` the model draws from it in one request (about 3–7 s). Without `data` it may first
`read`, `ls` and `grep` the conversation's working directory, read-only and never outside it (realpath checked), up to
eight steps in all. A model that cannot get the data answers in words, and the call fails with them. The idea comes
from json-render's catalog-constrained specs (Vercel Labs); six blocks did not need the library or its zod.

Every model step is memoized, so a rerun after a restart draws the same spec, and the steps' usage counts once on the
calling conversation. The call's details hold `{ spec, at, model, read? }`; the text the caller sees is one line naming
what was drawn.

## Card

The tool renderer draws the spec in a transcript `Card` with Ultimate's components and theme tokens; specs carry no
colours or styles. Charts are SVG, scale with the card, and label values on hover (every bar when there are few);
series use the brand, success, warning and error tones. Tables scroll inside the card; rows stack on narrow screens.
The header says **as of** the time it was drawn, so an old chart never reads as live; its tooltip names the files read.
While the model works the card shimmers with the request; a failed call shows the generic tool card with its error.

## Forms

A form's fields are kept in `sketch.forms` on the calling conversation, by call id. The user-only `submit { call,
values }` action checks the values against the fields, posts them to the conversation as the user's input
(`Submitted the form "…":` then `Label: value` lines; a follow-up while it is busy), and locks the form: the card then
shows the sent values and when. A second submit is refused. Question cards stay the way to ask decisions; forms are for
entering data.

Verification: `pnpm vitest run test/sketch.test.ts`.
