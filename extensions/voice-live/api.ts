/** Voice mode's contract: what it is built from. It has no service for other extensions. */

/** Voice talks through dictation's microphone and shortcut, speaks through read aloud's player and drives the user's page through page-agent's `ui` tool: without any of them it stays off. */
export const requires = ['dictation', 'read-aloud', 'page-agent']
