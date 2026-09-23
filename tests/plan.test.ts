import { describe, expect, it } from 'vitest'

import { analyze } from '../src/import/plan'
import { attr, entries, fixture, ids } from './fixtures'

function mutated(change: (f: ReturnType<typeof fixture>) => void) {
  const f = fixture()
  change(f)
  return new Map([
    ['config.json', Buffer.from(JSON.stringify(f.config))],
    ['entities/people.jsonl', Buffer.from(f.rows.map((x) => JSON.stringify(x)).join('\n'))],
  ])
}
describe('analysis before mutation', () => {
  it('maps typed values, provenance, presence, empty namespaces, and edges', () => {
    const plan = analyze(entries())
    expect(plan.totals).toEqual({ namespaces: 2, rows: 2, edges: 1, files: 0, bytes: 0 })
    const people = plan.namespaces.find((x) => x.source === 'people')!
    expect(people.rows[0].values.date).toBe('2024-02-29T12:34:56.789Z')
    expect(people.rows[0].values.json).toEqual([false, null, 0, '', {}, []])
    expect(people.rows[0].present).toContain('optional')
    expect(people.rows[1].present).not.toContain('optional')
    expect(people.rows[0].createdAt).toBe(123)
    expect(plan.links[0].edges).toEqual([[ids[0], ids[1]]])
  })
  it('is deterministic across entry ordering', () =>
    expect(analyze(entries())).toEqual(analyze(new Map([...entries()].reverse()))))
  it.each([
    [
      'count mismatch',
      (f: ReturnType<typeof fixture>) => {
        f.config.counts.people++
      },
    ],
    [
      'duplicate ID',
      (f: ReturnType<typeof fixture>) => {
        f.rows[1].entity.id = ids[0]
      },
    ],
    [
      'invalid UUID',
      (f: ReturnType<typeof fixture>) => {
        f.rows[0].entity.id = 'bad'
      },
    ],
    [
      'dangling edge',
      (f: ReturnType<typeof fixture>) => {
        f.rows[0].entity.friends = [ids[2]]
      },
    ],
    [
      'duplicate edge',
      (f: ReturnType<typeof fixture>) => {
        f.rows[0].entity.friends = [ids[1], ids[1]]
      },
    ],
    [
      'invalid type',
      (f: ReturnType<typeof fixture>) => {
        Object.assign(f.rows[0].entity, { score: '0' })
      },
    ],
    [
      'invalid date',
      (f: ReturnType<typeof fixture>) => {
        f.rows[0].entity.date = 'yesterday'
      },
    ],
    [
      'invalid creation timestamp',
      (f: ReturnType<typeof fixture>) => {
        f.rows[0].createdAt = 0.5
      },
    ],
    [
      'missing required attribute',
      (f: ReturnType<typeof fixture>) => {
        Reflect.deleteProperty(f.rows[0].entity, 'name')
      },
    ],
  ])('blocks %s', (_, change) => expect(() => analyze(mutated(change))).toThrow())
  it('enforces both one-link directions', () => {
    expect(() =>
      analyze(
        mutated((f) => {
          f.config.schema.links.friends.forward.has = 'one'
        })
      )
    ).toThrow()
    expect(() =>
      analyze(
        mutated((f) => {
          f.config.schema.links.friends.reverse.has = 'one'
          f.rows[1].entity.friends = [ids[1]]
        })
      )
    ).toThrow()
  })
  it('enforces required reverse relationships', () => {
    expect(() =>
      analyze(
        mutated((f) => {
          Object.assign(f.config.schema.links.friends.reverse, { required: true })
        })
      )
    ).toThrow()
  })
  it('preserves unknown fields and reports them', () => {
    const p = analyze(mutated((f) => Object.assign(f.rows[0].entity, { legacy: { a: 1 } })))
    expect(p.namespaces.find((x) => x.source === 'people')!.rows[0].values.legacy).toEqual({ a: 1 })
    expect(p.diagnostics.some((x) => x.code === 'unknown_attribute')).toBe(true)
  })
  it('rejects unknown namespaces and orphan blobs', () => {
    for (const path of ['entities/$unknown.jsonl', 'files/orphan', 'surprise.txt']) {
      const input = entries()
      input.set(path, Buffer.from(''))
      expect(() => analyze(input)).toThrow()
    }
  })
  it('detects uniqueness before target mutation', () => {
    expect(() =>
      analyze(
        mutated((f) => {
          f.config.schema.entities.people.attrs.name = attr('string', { config: { unique: true } })
          f.rows[1].entity.name = 'One'
        })
      )
    ).toThrow(/unique/i)
  })
  it('uses reversible encoding for Postgres-incompatible values', () => {
    const p = analyze(
      mutated((f) => {
        f.rows[0].entity.name = 'a\0b'
      })
    )
    expect(
      p.namespaces.find((x) => x.source === 'people')!.columns.find((x) => x.source === 'name')!
        .storage
    ).toBe('bytea')
  })
  it('allows known computed file URL omission and zero-byte blobs', () => {
    const input = new Map([
      [
        'config.json',
        Buffer.from(
          JSON.stringify({
            schema: {
              entities: {
                $files: { attrs: { path: attr(), url: attr('string', { required: true }) } },
              },
              links: {},
            },
            counts: { $files: 1 },
          })
        ),
      ],
      [
        'entities/$files.jsonl',
        Buffer.from(
          JSON.stringify({
            entity: {
              id: ids[0],
              path: '../logical/資料',
              'location-id': ids[1],
              size: 0,
              'content-type': 'text/plain',
            },
            createdAt: 0,
          })
        ),
      ],
      [`files/${ids[1]}`, Buffer.alloc(0)],
    ])
    const p = analyze(input)
    expect(p.files[0].size).toBe(0)
    expect(p.files[0].key).toBe(ids[0])
    input.delete(`files/${ids[1]}`)
    expect(() => analyze(input)).toThrow(/missing/i)
  })
})

describe('schema and file boundaries', () => {
  it('ignores packaging metadata explicitly', () => {
    const input = entries()
    input.set('.DS_Store', Buffer.from('ignored'))
    expect(analyze(input).diagnostics.some((d) => d.code === 'packaging_ignored')).toBe(true)
  })
  it('rejects whitespace-only and duplicate rows', () => {
    const input = entries()
    input.set('entities/people.jsonl', Buffer.from(' \n'))
    expect(() => analyze(input)).toThrow(/Blank JSONL record/)
  })
  it('caps undeclared attributes before a table exceeds the Postgres column limit', () => {
    const extras = (count: number) =>
      mutated((f) =>
        Object.assign(
          f.rows[0].entity,
          Object.fromEntries(Array.from({ length: count }, (_, i) => [`extra${i}`, i]))
        )
      )
    expect(() => analyze(extras(400))).not.toThrow()
    expect(() => analyze(extras(600))).toThrow(/Unsupported attribute schema/)
  })
  it('orders namespaces by code unit rather than locale collation', () => {
    const input = entries()
    const config = JSON.parse(input.get('config.json')!.toString())
    config.schema.entities.Zeta = { attrs: {} }
    config.schema.entities.alpha = { attrs: {} }
    input.set('config.json', Buffer.from(JSON.stringify(config)))
    expect(analyze(input).namespaces.map((n) => n.source)).toEqual([
      'Zeta',
      'alpha',
      'empty',
      'people',
    ])
  })
  it('rejects invalid calendar dates and timezone-less strings', () => {
    for (const date of [
      '2024-02-30T12:00:00Z',
      '2024-01-01T12:00:00',
      '2024-01-01T12:00:00.123456Z',
    ])
      expect(() =>
        analyze(
          mutated((f) => {
            f.rows[0].entity.date = date
          })
        )
      ).toThrow()
  })
  it('does not derive relationships from unknown UUID attributes', () => {
    const p = analyze(mutated((f) => Object.assign(f.rows[0].entity, { legacyRef: ids[2] })))
    expect(p.totals.edges).toBe(1)
    expect(p.diagnostics.some((d) => d.resource === 'people.legacyRef')).toBe(true)
  })
  it('blocks normalized duplicate UUIDs', () => {
    const id = 'aabbccdd-0000-4000-8000-000000000001'
    expect(() =>
      analyze(
        mutated((f) => {
          f.rows[0].entity.id = id
          f.rows[1].entity.id = id.toUpperCase()
        })
      )
    ).toThrow(/duplicate/i)
  })
  it('accepts native metadata omissions when counts are absent', () => {
    const input = entries()
    const config = JSON.parse(input.get('config.json')!.toString())
    delete config.counts
    input.set('config.json', Buffer.from(JSON.stringify(config)))
    expect(analyze(input).totals.rows).toBe(2)
  })
  it('preserves __proto__ as an own application attribute', () => {
    const input = entries()
    const rows = input
      .get('entities/people.jsonl')!
      .toString()
      .replace('"name":"One"', '"name":"One","__proto__":{"safe":true}')
    input.set('entities/people.jsonl', Buffer.from(rows))
    const p = analyze(input)
    expect(
      Object.hasOwn(p.namespaces.find((n) => n.source === 'people')!.rows[0].values, '__proto__')
    ).toBe(true)
  })
})
