/**
 * Secret redaction for text the fork shows that an agent or a person wrote
 * (an agent's memory, a message quoted as an instruction). Every route that
 * sends such text runs it through here first.
 */

const R = '[redacted]'
const SECRET_NAME = '(?:token|key|secret|password|passwd)'

// Base64 credentials always carry a digit, '+', '/', '=' or a capital after
// the first letter; "Basic Information" carries none, so prose survives.
function looksEncoded(token: string): boolean {
  return /[0-9+/=]/.test(token) || /[A-Z]/.test(token.slice(1))
}

// Order matters: whole headers and URLs go before the bare token shapes that
// would otherwise eat only part of them.
const SECRET_PATTERNS: Array<[RegExp, string | ((match: string, ...groups: string[]) => string)]> = [
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${R}@`],
  [/\b((?:proxy-)?authorization)\s*[:=]\s*(?:(?:bearer|basic|token|digest)\s+)?[^\s,;'"()[\]{}]+/gi, `$1: ${R}`],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${R}`],
  [/\b(basic)\s+([A-Za-z0-9+/]{8,}={0,2})/gi, (match, scheme, token) => (looksEncoded(token) ? `${scheme} ${R}` : match)],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, R],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, R],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, R],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, R],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, R],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, R],
  [new RegExp(`(--[a-z0-9-]*${SECRET_NAME}[a-z0-9-]*)(=|\\s+)("[^"]*"|'[^']*'|\\S+)`, 'gi'), `$1$2${R}`],
  [new RegExp(`\\b([A-Za-z0-9_]*${SECRET_NAME}[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\\s&"']+)`, 'gi'), `$1=${R}`],
  [new RegExp(`("[A-Za-z0-9_-]*${SECRET_NAME}[A-Za-z0-9_-]*"\\s*:\\s*)"[^"]*"`, 'gi'), `$1"${R}"`],
  [/\b(password|passwd|secret|token|api[_-]?key|client[_-]?secret)\s*:\s*[^\s,;]+/gi, `$1: ${R}`],
]

export function redact(text: string): string {
  let out = text
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement as (substring: string, ...args: string[]) => string)
  }
  return out
}

/** One line of at most `max` characters. Redacts before it cuts: a cut can
 *  split a secret into a shape the patterns no longer match. */
export function preview(raw: string | null | undefined, max: number): string | null {
  if (!raw) return null
  const flat = redact(raw).replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}
