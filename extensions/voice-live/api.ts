/** Voice mode's contract: what it is built from. It has no service for other extensions. */

/** Voice talks through dictation's microphone and shortcut and speaks through read aloud's player: without either it stays off. */
export const requires = ['dictation', 'read-aloud']
