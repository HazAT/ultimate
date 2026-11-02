import { AnsiUp } from 'ansi_up'

// Keep this control filter aligned with the chord sanitizeOutput patch.
const controls =
  // oxlint-disable-next-line no-control-regex -- consume terminal controls, preserving only numeric SGR
  /(?:\x1b\[|\x9b)[0-?]*[ -/]*(?:[@-~]|$)|(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)|(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)|\x1b[ -/]*[0-~]|[\x00-\x08\x0b-\x1f\x7f-\x9f\ufff9-\ufffb]/g

export function AnsiOutput({ output }: { output: string }) {
  const clean = output.replace(controls, (sequence) =>
    // oxlint-disable-next-line no-control-regex -- allow only numeric SGR
    /^\x1b\[[0-9;]*m$/.test(sequence) ? sequence : '',
  )
  const parser = new AnsiUp()
  // Only the library's escaped HTML is inserted, never raw tool output.
  parser.escape_html = true
  return <span dangerouslySetInnerHTML={{ __html: parser.ansi_to_html(clean) }} />
}
