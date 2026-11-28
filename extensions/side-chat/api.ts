/** Side chat uses dictation for the microphone and shortcut, read-aloud for playback, and page-agent for the `ui` tool. */
export const requires = ['dictation', 'read-aloud', 'page-agent']

/** A question card's Talk it through and the Inbox's question pane open a side chat; without questions or inbox only that part is missing. */
export const wants = ['questions', 'inbox']
