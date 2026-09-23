import { startBrowserJob } from '../../../../../src/server/jobs'

export const maxDuration = 300
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  return startBrowserJob(request, id)
}
