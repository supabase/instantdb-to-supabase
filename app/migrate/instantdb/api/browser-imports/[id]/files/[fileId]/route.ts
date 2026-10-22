import { completeBrowserFile } from '../../../../../../../../src/server/jobs'

export const maxDuration = 300
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; fileId: string }> }
) {
  const { id, fileId } = await context.params
  return completeBrowserFile(request, id, fileId)
}
