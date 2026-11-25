/** Setup's contract: what it uses. Its actions are in refs.ts. */

/** Setup checks again when health reports a change; without health it checks on its own schedule. */
export const wants = ['health']
