/** Run a program without a shell: resolves `{ stdout, stderr }`, rejects with them attached to execFile's error. */
export { execFile as exec } from './spawn.ts'
