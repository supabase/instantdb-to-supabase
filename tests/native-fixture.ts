import { attr, fullEntries, ids } from './fixtures'

export function nativeInput() {
  const input = fullEntries()
  const config = JSON.parse(input.get('config.json')!.toString())
  config.counts.$streams = 1
  config.counts.$oauthProviders = 1
  config.schema.entities.$streams = { attrs: { done: attr('boolean') } }
  config.schema.entities.profiles = { attrs: { bio: attr() } }
  config.schema.links.avatar = {
    forward: { on: 'people', label: 'avatar', has: 'one' },
    reverse: { on: '$files', label: 'avatars', has: 'many' },
  }
  config.schema.links.attachments = {
    forward: { on: 'people', label: 'attachments', has: 'many' },
    reverse: { on: '$files', label: 'attachments', has: 'many' },
  }
  config.schema.links.owner = {
    forward: { on: 'people', label: 'owner', has: 'one' },
    reverse: { on: '$users', label: 'people', has: 'many' },
  }
  config.schema.links.stream = {
    forward: { on: 'people', label: 'stream', has: 'one', required: true },
    reverse: { on: '$streams', label: 'people', has: 'many' },
  }
  config.schema.links.streamFiles = {
    forward: { on: '$streams', label: '$files', has: 'many' },
    reverse: { on: '$files', label: '$stream', has: 'one' },
  }
  input.set('config.json', Buffer.from(JSON.stringify(config)))
  const rows = input
    .get('entities/people.jsonl')!
    .toString()
    .split('\n')
    .map((r) => JSON.parse(r))
  rows[0].entity.avatar = ids[0]
  rows[0].entity.attachments = [ids[0], ids[2]]
  rows[0].entity.owner = ids[0]
  rows[1].entity.owner = ids[1]
  for (const row of rows) row.entity.stream = ids[0]
  input.set('entities/people.jsonl', Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n')))
  input.set(
    'entities/$streams.jsonl',
    Buffer.from(
      JSON.stringify({ entity: { id: ids[0], done: true, $files: [ids[1], ids[2]] }, createdAt: 0 })
    )
  )
  input.set(
    'entities/$oauthProviders.jsonl',
    Buffer.from(JSON.stringify({ entity: { id: ids[0], name: 'example-provider' }, createdAt: 0 }))
  )
  return input
}
