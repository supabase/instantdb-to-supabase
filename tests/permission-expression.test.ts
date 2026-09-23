import { describe, expect, it } from 'vitest'

import { parsePermission } from '../src/import/permission-expression'

describe('bounded permission parser', () => {
  it('parses precedence and associativity without source substitution', () => {
    const parsed = parsePermission('true || false && 1 < 2')
    expect(parsed).toMatchObject({
      kind: 'binary',
      operator: '||',
      right: { kind: 'binary', operator: '&&', right: { operator: '<' } },
    })
    expect(parsePermission('(true || false) && !false')).toMatchObject({
      operator: '&&',
      left: { operator: '||' },
      right: { kind: 'not' },
    })
  })
  it.each(["''", '""', "'a\\n\\r\\t\\\\b'", "'say \\'hi\\''", '"say \\"hi\\""'])(
    'parses supported string literal %s',
    (value) => {
      expect(parsePermission(value)).toMatchObject({ kind: 'literal' })
    }
  )
  it.each(['-1', '1.5', '0', '1e2', '1E-2'])('parses supported number %s', (value) => {
    expect(parsePermission(value)).toEqual({ kind: 'literal', value: Number(value) })
  })
  it.each([
    '',
    ' ',
    '01',
    '1e999',
    '9007199254740992',
    '1 + 2',
    'true; SELECT 1',
    'data.',
    'data..name',
    'data.ref(name)',
    "data.ref('a.id', 'b')",
    "'unterminated",
    "'\\u0041'",
    'a ? b : c',
    'true false',
    '(true',
    'true)',
    '[1,]',
    'true &&',
    "data.ref('x.id').size()",
    '/* true */',
    '{}',
  ])('rejects unsupported or malformed input %s', (value) => {
    expect(() => parsePermission(value)).toThrow()
  })
  it('does not confuse identifier names with literal token types', () => {
    expect(parsePermission('string')).toEqual({ kind: 'name', path: ['string'] })
    expect(parsePermission('number')).toEqual({ kind: 'name', path: ['number'] })
    for (const value of ['data.ref(string)', 'data.ref(number)', 'auth.ref(string)'])
      expect(() => parsePermission(value)).toThrow(/literal path/)
    expect(parsePermission("data.ref('friends.id')")).toEqual({
      kind: 'ref',
      root: 'data',
      path: 'friends.id',
    })
  })
  it('rejects NUL characters that Postgres SQL cannot represent', () => {
    expect(() => parsePermission("data.name == 'a\0b'")).toThrow(/NUL/)
  })
  it('enforces byte-independent expression, token, and nesting limits', () => {
    expect(() => parsePermission(' '.repeat(8193))).toThrow(/8192/)
    expect(() => parsePermission(Array(600).fill('true').join('||'))).toThrow(/tokens/)
    expect(() => parsePermission('!'.repeat(66) + 'true')).toThrow(/deeply/)
    expect(() => parsePermission(null)).toThrow()
  })
})
