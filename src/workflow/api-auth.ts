import { timingSafeEqual } from 'node:crypto'

export function authorized(request: Request) {
  const expected = process.env.IMPORT_WORKFLOW_TOKEN
  if (!expected) return false
  const actual = request.headers.get('authorization') ?? ''
  const a = Buffer.from(actual),
    b = Buffer.from(`Bearer ${expected}`)
  return a.length === b.length && timingSafeEqual(a, b)
}
