import { describe, expect, it } from 'vitest'

import { analyze } from '../src/import/plan'
import { buildSchema } from '../src/import/sql'
import { attr, entries, fullEntries } from './fixtures'

describe('generated SQL', () => {
  it('closes all imported tables and helpers to client roles', () => {
    const sql = buildSchema(analyze(entries()), 'instant_test').join('\n')
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY')
    expect(sql).toContain('REVOKE ALL')
    expect(sql).toContain('anon, authenticated')
    expect(sql).toContain('FOREIGN KEY')
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED')
  })
  it('defers every generated foreign key and gives each file one distinct object', () => {
    const input = fullEntries(),
      config = JSON.parse(input.get('config.json')!.toString())
    config.schema.entities.$files.attrs.caption = attr()
    input.set('config.json', Buffer.from(JSON.stringify(config)))
    const sql = buildSchema(analyze(input), 'instant_test').join('\n')
    expect(sql).toContain(
      'storage_object_id uuid NOT NULL REFERENCES storage.objects(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED UNIQUE'
    )
    expect(sql).toContain(
      'auth_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED UNIQUE'
    )
    for (const line of sql.split('\n'))
      if (line.includes('REFERENCES')) expect(line).toContain('DEFERRABLE INITIALLY DEFERRED')
  })
  it('quotes the schema identifier', () => {
    const sql = buildSchema(analyze(entries()), 'x"; DROP SCHEMA public; --').join('\n')
    expect(sql).toContain('"x""; DROP SCHEMA public; --"')
  })
})
