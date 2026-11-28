Side chat is a temporary fork you can type or talk to without interrupting the source conversation. Replies are read aloud by default. Open it from @ultimate's composer or use **Talk it through** to discuss a question with the conversation that asked it.

## Open and talk

- Use **Side chat** by @ultimate's composer, or press **Tab** there to switch the composer between Normal and Side chat. The command **Side chat: open or hide** (`Ctrl/⌘+Shift+V`) shows or hides the window.
- On the agent surface at 1280 px or wider, the window docks beside its source. It floats on smaller desktops and other surfaces, and opens as a bottom sheet on a phone. Closing the window does not end the chat: an open side chat can be brought back from the sidebar.
- Type, click the mic, or use the Talk shortcut to speak. Both go to the same fork, and you can paste screenshots. The microphone and its cues are shared with dictation; playback and speech settings are shared with read-aloud. You can interrupt a reply with a new turn or switch off spoken replies.

## Handoff and ending

A fork starts with the source's last completed input and answer, takes up the source's recent activity as it changes, and gets its own prompt for thinking things through with you. It can read and do quick checks, but cannot edit files. If you ask it to hand work off, `side_chat_handoff` sends a brief to the source or to a branch on screen. The brief links back to the chat. The chat stays open unless you ask it to hand off and close; then it ends after its closing reply without sending a second summary.

**Start fresh** ends the fork now; it also ends after 20 quiet minutes. If something was decided or left open beyond what was already handed off, a summary card goes back to the source without waking it. The window keeps the previous transcript and shows how it ended. The next typed or spoken turn starts a new fork and carries its summary forward.

## Talk through a question

**Talk it through** on an open question card forks the asker at the question's tool round. It opens the same Side chat window or shows it in the Inbox reading pane. The question stays pinned and can be folded. The two cards share their draft; the assistant may fill it with `draft_answers` but cannot send it. Review the draft and choose **Send answer**. That ends the fork, returns anything worth summarizing, and answers the card once. If the card was answered elsewhere in the meantime, nothing is sent twice.

## Setup

Side chat is on by default and requires `dictation`, `read-aloud` and `page-agent`, which are also on by default. Text only needs a model login. To talk, use a microphone on a secure page and add `OPENAI_API_KEY` in **Secrets** (an OpenAI provider API key can also supply transcription). The setup card tells you what is missing. Gemini models receive the recording on the newest turn and text thereafter; other models receive the transcript.

Pick a model and thinking level in the side chat composer. The project keeps that pick for the next fork. Without a pick it reads `"sideChat": { "model": "provider/model" }` from `~/.ultimate/settings.json`, then uses `claude-code/claude-opus-5-5` if no model is configured. The default thinking level is low, clamped to the model's supported levels.

## Extension contract

`refs.ts` defines the `side-chat` actions and the two documents. `side-chat.session` on the root tracks each source's open fork or last ending, all fork ids, and the model pick. `side-chat.fork` holds fork-local state, including transcripts. `side-chat.transcribe` reads a recording from `<home>/side-chat/<fork>/`; `side-chat.quiet` handles inactivity, explicit ending, summary delivery and cleanup. The web facet renders turns, handoffs and summaries, including the formats already in stored history.
