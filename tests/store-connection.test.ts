import { Client } from 'pg'
import { describe, expect, it } from 'vitest'

import { storeConnectionOptions } from '../src/workflow/store'
import { supabaseDatabaseCa } from '../src/workflow/supabase-ca'

describe('service database TLS', () => {
  it.each(['aws-0-ap-southeast-1.pooler.supabase.com', 'db.abcdefghijklmnopqrst.supabase.co'])(
    'verifies the certificate and hostname for %s',
    (host) => {
      const options = storeConnectionOptions(
        `postgresql://postgres:secret@${host}:5432/postgres?sslmode=verify-full&application_name=importer`
      )
      const client = new Client(options)
      expect(client.ssl).toEqual({ ca: supabaseDatabaseCa, rejectUnauthorized: true })
      expect(new URL(options.connectionString).searchParams.get('application_name')).toBe(
        'importer'
      )
    }
  )

  it('prevents connection-string SSL options from replacing the trusted CA', () => {
    const options = storeConnectionOptions(
      'postgresql://postgres:secret@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=disable&sslrootcert=/missing&sslcert=/missing&sslkey=/missing&ssl=false'
    )
    expect(new Client(options).ssl).toEqual({ ca: supabaseDatabaseCa, rejectUnauthorized: true })
  })

  it.each([
    'postgresql://postgres:secret@127.0.0.1:5432/postgres',
    'postgresql://postgres:secret@database.example.com:5432/postgres?sslmode=verify-full',
    'postgresql://postgres:secret@aws-0.pooler.supabase.com.example.com:5432/postgres',
  ])('preserves operator configuration for other hosts: %s', (connectionString) => {
    expect(storeConnectionOptions(connectionString)).toEqual({ connectionString })
  })
})
