import { safeSql } from '@supabase/pg-meta'
import type { Client } from 'pg'

import { hash } from './input'

/** Catalog definitions, including policies/grants, must stay unchanged on resume. */
export async function schemaFingerprint(db: Client, schema: string) {
  const result = await db.query(
    safeSql`
    SELECT jsonb_build_object(
      'schema', (SELECT nspacl::text FROM pg_namespace WHERE nspname = $1),
      'tables', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.relname) FROM (
        SELECT c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.relacl::text,
          (SELECT jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attgenerated,a.attidentity,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
           FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
          (SELECT jsonb_agg(pg_get_constraintdef(co.oid) ORDER BY co.conname) FROM pg_constraint co WHERE co.conrelid=c.oid) AS constraints,
          (SELECT jsonb_agg(pg_get_triggerdef(tr.oid) ORDER BY tr.tgname) FROM pg_trigger tr WHERE tr.tgrelid=c.oid AND NOT tr.tgisinternal) AS triggers,
          (SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid) AS indexes
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f')
      ) t),
      'functions', (SELECT jsonb_agg(jsonb_build_array(p.proname,pg_get_functiondef(p.oid),p.proacl::text) ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1),
      'policies', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.tablename,p.policyname) FROM pg_policies p WHERE schemaname=$1)
    ) AS definition`,
    [schema]
  )
  return hash(JSON.stringify(result.rows[0].definition))
}
