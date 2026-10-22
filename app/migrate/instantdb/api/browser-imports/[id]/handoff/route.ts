import { browserHandoff } from '../../../../../../../src/server/handoff'

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return browserHandoff(request, (await context.params).id)
}
