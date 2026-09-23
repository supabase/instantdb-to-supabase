import { browserJobStatus, cancelBrowserJob } from '../../../../src/server/jobs'

export const maxDuration = 300
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  return browserJobStatus(request, id)
}
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return cancelBrowserJob(request, (await context.params).id)
}
