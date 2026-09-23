export const ids = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
]
export const attr = (valueType = 'string', extra = {}) => ({
  valueType,
  config: { unique: false, indexed: false },
  ...extra,
})
export function fixture() {
  return {
    config: {
      schema: {
        entities: {
          people: {
            attrs: {
              name: attr('string', { required: true }),
              optional: attr(),
              date: attr('date'),
              json: attr('any'),
              score: attr('number'),
              active: attr('boolean'),
            },
          },
          empty: { attrs: {} },
        },
        links: {
          friends: {
            forward: { on: 'people', label: 'friends', has: 'many' },
            reverse: { on: 'people', label: 'befriendedBy', has: 'many' },
          },
        },
      },
      counts: { people: 2 },
      rules: {},
    },
    rows: [
      {
        entity: {
          id: ids[0],
          name: 'One',
          optional: null,
          date: '2024-02-29T20:34:56.789+08:00',
          json: [false, null, 0, '', {}, []],
          score: 0,
          active: false,
          friends: [ids[1]],
        },
        createdAt: 123,
      },
      { entity: { id: ids[1], name: 'Two', date: 1709210096789 }, createdAt: 456 },
    ],
  }
}
export function entries() {
  const f = fixture()
  return new Map([
    ['config.json', Buffer.from(JSON.stringify(f.config))],
    ['entities/people.jsonl', Buffer.from(f.rows.map((x) => JSON.stringify(x)).join('\n'))],
  ])
}

export function fullEntries() {
  const input = entries()
  const config = JSON.parse(input.get('config.json')!.toString())
  config.schema.entities.$users = { attrs: { email: attr(), type: attr() } }
  config.schema.entities.$files = {
    attrs: { path: attr('string', { required: true }), url: attr('string', { required: true }) },
  }
  config.counts.$users = 2
  config.counts.$files = 3
  input.set('config.json', Buffer.from(JSON.stringify(config)))
  input.set(
    'entities/$users.jsonl',
    Buffer.from(
      [
        { entity: { id: ids[0], email: 'import-test@example.invalid' }, createdAt: 1 },
        { entity: { id: ids[1], type: 'guest' }, createdAt: 2 },
      ]
        .map((x) => JSON.stringify(x))
        .join('\n')
    )
  )
  input.set(
    'entities/$files.jsonl',
    Buffer.from(
      [
        {
          entity: {
            id: ids[0],
            path: '資料/hello.txt',
            'location-id': ids[0],
            size: 5,
            'content-type': 'text/plain',
          },
          createdAt: 1,
        },
        {
          entity: {
            id: ids[1],
            path: '../logical/empty',
            'location-id': ids[1],
            size: 0,
            'content-type': 'application/octet-stream',
          },
          createdAt: 2,
        },
        {
          entity: {
            id: ids[2],
            path: 'shared',
            'location-id': ids[0],
            size: 5,
            'content-type': 'text/plain',
          },
          createdAt: 3,
        },
      ]
        .map((x) => JSON.stringify(x))
        .join('\n')
    )
  )
  input.set(`files/${ids[0]}`, Buffer.from('hello'))
  input.set(`files/${ids[1]}`, Buffer.alloc(0))
  return input
}
