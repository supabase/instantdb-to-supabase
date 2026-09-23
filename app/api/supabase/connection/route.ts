import { connection } from 'next/server'

import { disconnectSupabase, supabaseConnection } from '../../../../src/server/oauth'

export async function GET(request: Request) {
  await connection()
  return supabaseConnection(request)
}
export const DELETE = disconnectSupabase
export const maxDuration = 60
