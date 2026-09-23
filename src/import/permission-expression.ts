/** A deliberately bounded CEL subset. Unknown syntax never becomes SQL. */
export type Expression =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'name'; path: string[] }
  | { kind: 'list'; items: Expression[] }
  | { kind: 'ref'; root: 'data' | 'auth'; path: string }
  | { kind: 'not'; value: Expression }
  | { kind: 'binary'; operator: string; left: Expression; right: Expression }

type Token = { text: string; value?: string | number }
const precedence: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  in: 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
}
export function parsePermission(source: unknown): Expression {
  if (typeof source !== 'string' || source.length > 8192)
    throw new Error('Expected a rule string of at most 8192 characters')
  if (source.includes('\0')) throw new Error('NUL characters require manual rule conversion')
  const tokens: Token[] = []
  let position = 0
  while (position < source.length) {
    if (/\s/.test(source[position])) {
      position++
      continue
    }
    const rest = source.slice(position)
    const string = /^(?:"(?:[^"\\\r\n]|\\["'\\nrt])*"|'(?:[^'\\\r\n]|\\["'\\nrt])*')/.exec(rest)
    if (string) {
      const text = string[0]
      const escapes: Record<string, string> = {
        n: '\n',
        r: '\r',
        t: '\t',
        "'": "'",
        '"': '"',
        '\\': '\\',
      }
      tokens.push({
        text: 'string',
        value: text.slice(1, -1).replace(/\\(.)/g, (_, c: string) => escapes[c]),
      })
      position += text.length
    } else {
      const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest)
      const word = /^[a-zA-Z_$][a-zA-Z0-9_$]*/.exec(rest)
      const operator = /^(?:&&|\|\||==|!=|<=|>=|[!<>()\[\],.])/.exec(rest)
      const match = number ?? word ?? operator
      if (!match) throw new Error('Unsupported rule syntax')
      const text = match[0]
      if (number) {
        const value = Number(text)
        if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
          throw new Error('Number is outside the supported exact range')
        tokens.push({ text: 'number', value })
      } else tokens.push({ text })
      position += text.length
    }
    if (tokens.length > 1024) throw new Error('Rule has too many tokens')
  }
  let index = 0
  const take = (expected: string) => {
    if (tokens[index++]?.text !== expected) throw new Error(`Expected ${expected}`)
  }
  const expression = (minimum = 0, depth = 0): Expression => {
    if (depth > 64) throw new Error('Rule is nested too deeply')
    const token = tokens[index++]
    if (!token) throw new Error('Incomplete rule')
    let left: Expression
    if (token.text === '!') left = { kind: 'not', value: expression(5, depth + 1) }
    else if (token.text === '(') {
      left = expression(0, depth + 1)
      take(')')
    } else if (token.text === '[') {
      const items: Expression[] = []
      if (tokens[index]?.text !== ']') {
        do {
          items.push(expression(0, depth + 1))
          if (tokens[index]?.text !== ',') break
          index++
        } while (true)
      }
      take(']')
      left = { kind: 'list', items }
    } else if (token.value !== undefined) left = { kind: 'literal', value: token.value! }
    else if (['true', 'false', 'null'].includes(token.text))
      left = { kind: 'literal', value: token.text === 'null' ? null : token.text === 'true' }
    else if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(token.text)) {
      const path = [token.text]
      while (tokens[index]?.text === '.') {
        index++
        const part = tokens[index++]?.text
        if (!part || !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(part)) throw new Error('Invalid field path')
        path.push(part)
      }
      if (
        tokens[index]?.text === '(' &&
        path.length === 2 &&
        ['data', 'auth'].includes(path[0]) &&
        path[1] === 'ref'
      ) {
        index++
        const argument = tokens[index++]
        // `text` is the token type tag, so a bare `string` identifier looks identical
        // to a string literal until its value is checked.
        if (argument?.text !== 'string' || argument.value === undefined)
          throw new Error('ref requires a literal path')
        take(')')
        left = {
          kind: 'ref',
          root: path[0] === 'data' ? 'data' : 'auth',
          path: String(argument.value),
        }
      } else {
        if (tokens[index]?.text === '(') throw new Error(`Unsupported function ${path.join('.')}`)
        left = { kind: 'name', path }
      }
    } else throw new Error('Unsupported expression')
    while (index < tokens.length) {
      const operator = tokens[index].text,
        level = Object.hasOwn(precedence, operator) ? precedence[operator] : undefined
      if (level === undefined || level < minimum) break
      index++
      left = { kind: 'binary', operator, left, right: expression(level + 1, depth + 1) }
    }
    return left
  }
  const result = expression()
  if (index !== tokens.length) throw new Error('Unsupported trailing syntax')
  return result
}
