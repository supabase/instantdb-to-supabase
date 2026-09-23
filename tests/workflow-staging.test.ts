import { describe, expect, it } from 'vitest'

import { decodeRow, type StagedRow } from '../src/workflow/staging'

const staged = (values: Record<string, unknown>): StagedRow => ({
  id: '00000000-0000-4000-8000-000000000001',
  namespace: 'people',
  raw: Buffer.from('{}'),
  normalized: Buffer.from(JSON.stringify(values)),
  created_at: '0',
  presence: Object.keys(values),
})

describe('staged row decoding', () => {
  it('reads an absent attribute named after a prototype member as missing', () => {
    const { values } = decodeRow(staged({ name: 'first' }))
    expect(Object.getPrototypeOf(values)).toBeNull()
    expect(values.toString).toBeUndefined()
    expect(values.constructor).toBeUndefined()
    expect(values.name).toBe('first')
  })
  it('keeps a stored attribute that shares a prototype member name', () => {
    expect(decodeRow(staged({ toString: 'label' })).values.toString).toBe('label')
  })
})
