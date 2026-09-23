import { jsonBody, sameOrigin } from '../../../src/server/session'
import { browserEventSchema } from '../../../src/telemetry/contracts'
import { captureBrowserEvent } from '../../../src/telemetry/server'

export async function POST(request: Request) {
  try {
    sameOrigin(request)
    const value = browserEventSchema.safeParse(await jsonBody(request, 2048))
    if (!value.success) return new Response(null, { status: 400 })
    return await captureBrowserEvent(request, value.data)
  } catch {
    return new Response(null, { status: 400 })
  }
}
