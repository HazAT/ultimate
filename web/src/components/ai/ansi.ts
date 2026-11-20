import { AnsiUp } from 'ansi_up'

const escape = String.fromCharCode(27)
const controls = new RegExp(
  String.raw`(?:${escape}\[|\x9b)[0-?]*[ -/]*(?:[@-~]|$)|(?:${escape}\]|\x9d)[\s\S]*?(?:${String.fromCharCode(7)}|${escape}\\|\x9c|$)|(?:${escape}[PX^_]|[\x90\x98\x9e\x9f])[\s\S]*?(?:${escape}\\|\x9c|$)|${escape}[ -/]*[0-~]|[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}-${String.fromCharCode(31)}\x7f-\x9f\ufff9-\ufffb]`,
  'g',
)
const sgr = new RegExp(String.raw`^${escape}\[[0-9;]*m$`)

export function ansiHtml(output: string) {
  const clean = output.replace(controls, (sequence) => (sgr.test(sequence) ? sequence : ''))
  const parser = new AnsiUp()
  parser.escape_html = true
  return parser.ansi_to_html(clean)
}
