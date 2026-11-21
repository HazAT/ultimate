const MASK = '[redacted]'

const RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  [/(:\/\/[^\s/:@]*:)[^\s/@]+@/g, `$1${MASK}@`],
  [/\b(Authorization["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic)\s)[\w-]+ +[^\s"',]+/gi, `$1${MASK}`],
  [/(?<![\w-])eyJ[\w-]+\.[\w-]+\.[\w-]*/g, MASK],
  [/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, `$1 ${MASK}`],
  [/\b(?:sk|pk|rk)-[\w-]{8,}/g, MASK],
  [/\bgh[pousr]_\w{4,}/g, MASK],
  [/\bgithub_pat_\w{4,}/g, MASK],
  [/\bxox[abposr]-[\w-]{4,}/g, MASK],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, MASK],
]

const LABEL = /(?<![\w-])[\w-]+["']?\s*[=:]\s*/g
const SECRET_LABEL =
  /(?:key|token|secret|password|passwd|pwd|passphrase|credentials?|cookie|auth|authorization)[\d_]*["']?\s*[=:]\s*$/i
const VALUE = /(?!(?:Bearer|Basic) |\[redacted\])(?:"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|\S+)/y

function maskAssignments(text: string) {
  let out = ''
  let from = 0
  for (const label of text.matchAll(LABEL)) {
    const start = label.index + label[0].length
    if (label.index < from || !SECRET_LABEL.test(label[0])) continue
    VALUE.lastIndex = start
    const value = VALUE.exec(text)
    if (!value) continue
    out += text.slice(from, start) + MASK
    from = start + value[0].length
  }
  return out + text.slice(from)
}

const RUN = /(?<![\w+/=-])[\w+/=-]{24,}/g

const tokenShaped = (run: string) =>
  /\d/.test(run) && run.split(/[-_/.=]/).some((part) => part.length >= 16)

export const redactSecrets = (text: string) =>
  maskAssignments(
    RULES.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text),
  ).replace(RUN, (run) => (tokenShaped(run) ? MASK : run))
