# Sounds

Short, soft notification sounds when @ultimate talks to you: a question (needs input), a
finished answer, or a failed run, and when work lands; an opt-in **narrator** that says what each one is about; and an
opt-in **sound of agents** that plays the whole project's activity as music.
"sounds" in the status bar opens a switch for all of them, a volume slider, the narrator, the sound of agents with its
variants and demo, and a checkbox and a play button for each notification; the choices live in `ext.sounds.muted`,
`ext.sounds.volume`, `ext.sounds.narrator`, `ext.sounds.narrateBranches`, `ext.sounds.agents` and `ext.sounds.off`.

## Notifications

Only the primary standing agent sounds, read from the root's documents:

- **Needs input:** any reply-expected `message` to the user (`messages`), from @ultimate or a branch.
- **Finished:** its one-way `message` to the user, or its answer to your typed input.
- **Failed:** its run ended in an error (`ultimate.conversation-overview`); a stop or a reset does not.
- **Landed:** a submission landed on the project's target branch (the `workspaces.landed` event), from any branch.

Nothing else notifies: branches, workers, the lander, other standing agents, messages to you from anyone else, and
@ultimate's answers to other agents' messages (`internalInput`). A landing that arrives while the tab is hidden, its
stream is down, or within three seconds of it showing again or reconnecting is taken as heard, as in the sound of
agents.

Each event sounds once. Whatever the documents show when a tab opens has been heard already, and of several open tabs
the first that may play claims the event under a Web Lock in local storage. Browsers let a page play only after
someone clicked or typed in it, so a tab that never had input leaves the event to another. `cues.ts` decides what
sounds.

## Narrator

Off by default. Turned on, each notification's sound leads into a short spoken line, written from the event by
`narration.ts` (no model writes it):

- **Needs input:** "Ultimate has a question.", or "MCP support needs your answer." naming the asking branch.
- **Failed:** "Ultimate stopped with an error."
- **Landed:** "Landed: sketch tool."; several at once: "Two branches landed: sketch tool and file drops.", and past
  three only the count.
- **New branch**, only with **Announce new branches** checked: "Started: fix the flaky test."
- **Finished** keeps its sound alone: the answer is on screen.

It gathers cues for 1.5 s and speaks one line per kind, questions first, one line at a time; what arrives meanwhile
joins the next. A title is cut to its first eight words. Unlike the other sounds it speaks while the tab is hidden, but
nothing that happened while the stream was down or before the tab opened. Tabs of one browser share a claim; tabs on
several machines each speak.

The `say` action (`server.ts`) speaks a line with OpenAI's `gpt-realtime-2.1-mini` over one realtime WebSocket
response, with the `OPENAI_API_KEY` secret that voice input uses (or an API key Pi's `openai` provider holds), and keeps
the last 50 lines in memory, so a repeat plays at once. The line's text, branch titles included, goes to OpenAI.
Without a key the browser's own `speechSynthesis` says it. The voice plays through the same volume.

## Sound of agents

Off by default. Turned on, every tab plays the project: `agents.ts` follows the conversation list (busy states and
each one's role from its label), each busy conversation's `pi.live` (its tool calls by name and whether its model
streams; a fast call passes through there but often not through the coalesced task graph) and the event feed (`coding-tools.committed`, `workspaces.landed`, failed `workspaces.check`), plus
failed runs from the overview. It turns them into happenings (a conversation starts or stops, a tool call by timbre,
a commit, a landing, a failure). Only happenings sound: there is no background drone, pad or beat, so idle is silence.
Each variant keeps one tempo, set once when it starts: busier work plays more notes, never a faster beat (Tone keeps
every tempo change on a timeline it never prunes).

Only what happens while the tab is shown sounds. Until every source has arrived, while the tab is hidden or its
stream is down, and for three seconds after it opens, shows again or reconnects, what arrives is taken as heard: a tab
coming back never plays what happened while it was away. A beat the throttled clock of a hidden tab catches up on
drops what it holds.

Three variants, all in D major over a I–vi–IV–V progression and quantized to a sixteenth, with a cap on happenings per
step. Each role has a motif, a short contour over the current chord that its tool calls walk one step at a time, so a
role's calls form a phrase rather than random notes; a failure leaves tension unresolved. Every variant lands with the
notifications' kalimba: Finished with the octave under its last note. While the Landed notification is on, it plays
the landing and the band leaves it out, so a landing sounds once.

- **Chiptune:** NES style, two pulse channels, a triangle bass and a noise drum, one note each at a time, at 150 bpm. Edits a small coin, commands a drum tick on the bass, reads a quiet blip; a commit the coin "ba-ding", a
  start a 1-up, a failure a bump sliding to a tritone.
- **Orchestra:** at 96 bpm, each role an instrument (@ultimate strings, coordinators cello, workers plucks, scouts flute,
  reviewers marimba, the lander brass); tools are articulations, a start an upward chord and a stop its answer down,
  a commit a small leading-tone close, a failure a diminished seventh.
- **Crazy:** a driving 128 bpm; bash a snare, edits walk an acid riff on the bar's root, reads
  hats, browser calls zaps; every call bites a bitcrusher harder; a failure crunches.

**Start demo** (in the popover, or ⌘K "Play the sound of agents demo") plays about 40 seconds of a scripted feature
through the same mapping: a coordinator, a scout, two workers, a commit, a failed check, reviewers, the lander and a
landing. Real activity plays along.

## Engine

Everything is synthesized with Tone.js in `engine.ts`, loaded on first sound (Tone opens an AudioContext when it
loads): a kalimba for the notifications and landings, in a short room so nothing lingers, a limiter, and the three
bands. The notifications share one motif in G: Needs input rises a fourth (D–G), Finished falls home from the fifth
(D–B–G), Landed is Finished with the octave under its last note and a faint sparkle above, Failed falls to B♭; each lasts at most about 0.6 s. Other extensions' `playNotes` play soft FM bells. A page plays only after a click or key press; with the sound of agents on after a reload, the popover says
"Click anywhere to start audio" and the first click starts it. `ui.tsx` exports `playNotes` for other extensions.
