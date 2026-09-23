export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** Reject ambiguity before JSON.parse can discard duplicate keys or round integers. */
export function parseJson(bytes: Buffer, maxDepth = 64): Json {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  let at = 0
  const fail = (reason: string): never => {
    throw new Error(`Invalid JSON at offset ${at}: ${reason}`)
  }
  const whitespace = () => {
    while (/[\x20\t\n\r]/.test(text[at] ?? '\0')) at++
  }
  const string = (): string => {
    const start = at++
    while (at < text.length) {
      if (text[at] === '\\') {
        at += 2
        continue
      }
      if (text[at++] === '"') {
        // JSON.parse rejects raw control characters and unsupported escapes. Report
        // them through fail() so callers never see a bare SyntaxError.
        let result: string
        try {
          result = JSON.parse(text.slice(start, at)) as string
        } catch {
          return fail('unsupported escape or control character in string')
        }
        if (!result.isWellFormed()) fail('unpaired surrogate')
        return result
      }
    }
    return fail('unterminated string')
  }
  const value = (depth: number): Json => {
    if (depth > maxDepth) fail('depth limit exceeded')
    whitespace()
    if (text[at] === '"') return string()
    if (text[at] === '{' || text[at] === '[') {
      const object = text[at++] === '{'
      const end = object ? '}' : ']'
      const result: Record<string, Json> = Object.create(null)
      const array: Json[] = []
      whitespace()
      if (text[at] === end) {
        at++
        return object ? result : array
      }
      while (true) {
        whitespace()
        if (object) {
          if (text[at] !== '"') fail('expected key')
          const key = string()
          if (Object.hasOwn(result, key)) fail('duplicate key')
          whitespace()
          if (text[at++] !== ':') fail('expected colon')
          result[key] = value(depth + 1)
        } else array.push(value(depth + 1))
        whitespace()
        if (text[at] === end) {
          at++
          return object ? result : array
        }
        if (text[at++] !== ',') fail('expected comma')
      }
    }
    for (const [token, result] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (text.startsWith(token, at)) {
        at += token.length
        return result
      }
    }
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at))?.[0]
    if (!token) return fail('expected value')
    at += token.length
    const number = Number(token)
    if (!Number.isFinite(number) || decimalIdentity(token) !== decimalIdentity(String(number)))
      fail('number outside supported range')
    return number
  }
  const result = value(0)
  whitespace()
  if (at !== text.length) fail('trailing data')
  return result
}

/**
 * Code-unit ordering. `localeCompare` is ICU- and locale-dependent, so it neither
 * matches Postgres byte ordering nor produces a stable content hash across hosts.
 */
export const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`
  return JSON.stringify(value)
}

// Compare decimal spellings without first rounding through a JS number. Large
// exponent-form doubles are valid; an integer rounded by JSON.parse is not.
function decimalIdentity(token: string): string {
  const negative = token.startsWith('-')
  const [mantissa, exponent = '0'] = token.replace(/^-/, '').toLowerCase().split('e')
  const [whole, fraction = ''] = mantissa.split('.')
  let digits = (whole + fraction).replace(/^0+/, '')
  if (!digits) return '0'
  let scale = Number(exponent) - fraction.length
  while (digits.endsWith('0')) {
    digits = digits.slice(0, -1)
    scale++
  }
  return `${negative ? '-' : ''}${digits}e${scale}`
}
