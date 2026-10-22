import { connection } from 'next/server'

import { supabaseCallback } from '../../../../../../src/server/oauth'

export async function GET(request: Request) {
  await connection()
  return supabaseCallback(request)
}
export const maxDuration = 60
