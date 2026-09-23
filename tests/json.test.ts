import { describe, expect, it } from 'vitest'

import { parseJson } from '../src/import/json'

describe('strict JSON', () => {
  it.each(['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":{"a":1,"a":2}}'])(
    'rejects duplicate keys: %s',
    (value) => {
      expect(() => parseJson(Buffer.from(value))).toThrow(/duplicate/i)
    }
  )
  it.each(['1e999', '9007199254740993', '1e-999', 'NaN', '{', '[1,]', 'true false', '"\\ud800"'])(
    'rejects lossy or malformed JSON: %s',
    (value) => {
      expect(() => parseJson(Buffer.from(value))).toThrow()
    }
  )
  it('rejects invalid UTF-8', () => expect(() => parseJson(Buffer.from([0xff]))).toThrow())
  it('reports raw control characters through its own error, not a bare SyntaxError', () => {
    expect(() => parseJson(Buffer.from('{"a":"b\u0001c"}'))).toThrow(/Invalid JSON at offset \d+:/)
  })
  it('limits nesting', () =>
    expect(() => parseJson(Buffer.from('['.repeat(70) + '0' + ']'.repeat(70)))).toThrow(/depth/i))
  it('preserves special keys, scalars, and null characters', () => {
    const value = parseJson(
      Buffer.from('{"__proto__":{"polluted":true},"s":"a\\u0000b","x":[null,false,0,""]}')
    )
    expect(Object.hasOwn(value as object, '__proto__')).toBe(true)
    expect(value).toHaveProperty('s', 'a\0b')
    expect({}).not.toHaveProperty('polluted')
  })
})

describe('numeric fidelity', () => {
  it.each([
    '1e100',
    '1.7976931348623157e308',
    '5e-324',
    '0.30000000000000004',
    '9007199254740991',
    '-9007199254740991',
  ])('preserves %s', (value) => {
    expect(parseJson(Buffer.from(value))).toBe(Number(value))
  })
  it.each(['0.10000000000000001', '9007199254740993.0', '9.007199254740993e15'])(
    'rejects silent rounding of %s',
    (value) => expect(() => parseJson(Buffer.from(value))).toThrow()
  )
})
