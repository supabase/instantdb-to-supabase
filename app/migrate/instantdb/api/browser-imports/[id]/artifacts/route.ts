import { downloadArtifacts } from '../../../../../../../src/server/jobs'

export const maxDuration = 300
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  return downloadArtifacts(request, id)
}
