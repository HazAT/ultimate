/** Dream's contract: what it uses. Its documents and actions are in refs.ts. */

/**
 * The morning card checks that @ultimate is awake in a side chat; a built-in's fire asks the user to dream in the
 * Inbox. Without side-chat that check is hidden; without inbox the ask waits unseen and only Dream starts one.
 */
export const wants = ['side-chat', 'inbox']
