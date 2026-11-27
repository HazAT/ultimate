/** The Extensions manager for other extensions' Solid code. */

/**
 * More of an open row in the Extensions panel, below its tools and contract (`mcp` lists its servers there). Input is
 * the extension's name; the provider renders nothing for the others.
 */
export { ExtensionDetails } from './points.web.ts'
/**
 * The dialog id the panel's About this setup opens; `onboarding` answers it by asking @ultimate about the project's
 * setup.
 */
export { projectHelpDialog } from './points.web.ts'
/**
 * `useDescribed()` reads each extension's README line (`line(name)`) for lists of extensions, such as onboarding's
 * recommended extras; `Line` renders such a line with its `code` spans.
 */
export { Line, useDescribed } from './parts.solid.tsx'
