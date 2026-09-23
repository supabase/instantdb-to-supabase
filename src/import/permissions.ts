import { ident, joinSqlFragments, literal, safeSql, type SafeSqlFragment } from '@supabase/pg-meta'

import { parsePermission, type Expression } from './permission-expression'
import { foreignKeysFor, publicTables } from './relational'
import type { Namespace, Plan } from './types'

const actions = ['view', 'create', 'update', 'delete'] as const
type Action = (typeof actions)[number]
type ObjectValue = Record<string, unknown>
const object = (value: unknown): value is ObjectValue =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const own = (value: ObjectValue, key: string) => Object.hasOwn(value, key)
export type PermissionRule = {
  namespace: string
  action: string
  source: string
  expression: unknown
  bindings?: unknown
  target?: string
  status: 'converted' | 'manual' | 'excluded'
  effect?: 'allow' | 'deny'
  reason?: string
  suggestion?: string
}
type Value = {
  sql: SafeSqlFragment
  type: 'string' | 'number' | 'boolean' | 'null'
  data: boolean
  /** The compiled SQL can evaluate to NULL. */
  nullable: boolean
  /** Resolves to the request identity, which is NULL for anonymous requests. */
  identity?: boolean
}
const operators: Record<string, SafeSqlFragment> = {
  '&&': safeSql`AND`,
  '||': safeSql`OR`,
  '==': safeSql`IS NOT DISTINCT FROM`,
  '!=': safeSql`IS DISTINCT FROM`,
  '<': safeSql`<`,
  '<=': safeSql`<=`,
  '>': safeSql`>`,
  '>=': safeSql`>=`,
}
const qualified = (ns: Namespace) => safeSql`${ident(ns.destination)}.${ident(ns.target)}`

/** All identifiers and literals originate in the validated model and are escaped here. */
class Compiler {
  private steps = 0
  /**
   * The source `==` is compiled as IS NOT DISTINCT FROM to keep the rule faithful, so a
   * comparison against the identity also matches rows whose column is NULL when
   * auth.uid() is NULL. That is reported rather than silently changed.
   */
  anonymousNullMatch = false
  constructor(
    private plan: Plan,
    private ns: Namespace,
    private bindings: ObjectValue
  ) {}
  private identity(): SafeSqlFragment {
    const users = this.plan.namespaces.find((n) => n.source === '$users')
    if (users?.destination === 'public')
      throw new Error(
        'Source user IDs require a profile lookup. Choose the Auth/profile identity model in a local migration before granting access.'
      )
    return safeSql`(SELECT auth.uid())::text`
  }
  private field(ns: Namespace, field: string, alias: SafeSqlFragment): Value {
    if (field === 'id') {
      if (ns.destination === 'storage')
        throw new Error('Storage IDs and source file IDs have different meanings')
      return { sql: safeSql`${alias}.id::text`, type: 'string', data: true, nullable: false }
    }
    const column = ns.columns.find((c) => c.source === field)
    if (
      !column ||
      ns.destination !== 'public' ||
      !['text', 'double precision', 'boolean'].includes(column.storage)
    )
      throw new Error(`Field ${field} is not a supported scalar column`)
    const type =
      column.storage === 'text' ? 'string' : column.storage === 'boolean' ? 'boolean' : 'number'
    return {
      sql: safeSql`${alias}.${ident(column.target)}`,
      type,
      data: true,
      nullable: !column.required,
    }
  }
  compile(node: Expression, stack: string[] = []): Value {
    if (++this.steps > 64 || stack.length > 8) throw new Error('Expanded rule is too complex')
    if (node.kind === 'literal')
      return {
        sql:
          node.value === null
            ? safeSql`NULL`
            : typeof node.value === 'boolean'
              ? node.value
                ? safeSql`true`
                : safeSql`false`
              : literal(node.value),
        type:
          node.value === null
            ? 'null'
            : typeof node.value === 'string'
              ? 'string'
              : typeof node.value === 'boolean'
                ? 'boolean'
                : 'number',
        data: false,
        nullable: node.value === null,
      }
    if (node.kind === 'name') {
      if (node.path.length === 1 && own(this.bindings, node.path[0])) {
        const name = node.path[0]
        if (stack.includes(name)) throw new Error('Cyclic rule bindings')
        return this.compile(parsePermission(this.bindings[name]), [...stack, name])
      }
      if (node.path.join('.') === 'auth.id')
        return {
          sql: this.identity(),
          type: 'string',
          data: false,
          nullable: true,
          identity: true,
        }
      if (node.path.length === 2 && node.path[0] === 'data')
        return this.field(this.ns, node.path[1], ident(this.ns.target))
      throw new Error(`Unsupported variable ${node.path.join('.')}`)
    }
    if (node.kind === 'not') {
      const value = this.compile(node.value, stack)
      if (value.type !== 'boolean') throw new Error('Negation requires a boolean')
      return { ...value, sql: safeSql`(NOT (${value.sql}))` }
    }
    if (node.kind !== 'binary')
      throw new Error('Lists and references are supported only in membership checks')
    if (node.operator === 'in' && node.right.kind === 'ref')
      throw new Error(
        'Graph references require application-specific joins and authorization. Implement a readable policy or server operation in a local migration.'
      )
    const left = this.compile(node.left, stack)
    if (node.operator === 'in') {
      if (node.right.kind !== 'list' || node.right.items.some((i) => i.kind !== 'literal'))
        throw new Error('Membership requires a literal list or supported reference')
      const items = node.right.items.map((item) => this.compile(item, stack))
      if (
        items.some(
          (item) => item.type !== left.type && item.type !== 'null' && left.type !== 'null'
        )
      )
        throw new Error('List membership has incompatible types')
      if (left.identity && items.some((item) => item.nullable)) this.anonymousNullMatch = true
      return {
        sql: items.length
          ? safeSql`(${joinSqlFragments(
              items.map((item) => safeSql`(${left.sql} IS NOT DISTINCT FROM ${item.sql})`),
              ' OR '
            )})`
          : safeSql`false`,
        type: 'boolean',
        data: left.data,
        nullable: false,
      }
    }
    const right = this.compile(node.right, stack),
      operator = own(operators, node.operator) ? operators[node.operator] : undefined
    if (!operator) throw new Error('Unsupported operator')
    if (['&&', '||'].includes(node.operator)) {
      if (left.type !== 'boolean' || right.type !== 'boolean')
        throw new Error('Logical operators require booleans')
    } else if (['<', '<=', '>', '>='].includes(node.operator)) {
      if (left.type !== 'number' || right.type !== 'number')
        throw new Error('Ordering is supported only for numbers')
    } else if (left.type !== right.type && left.type !== 'null' && right.type !== 'null')
      throw new Error('Comparison has incompatible types')
    if (
      node.operator === '==' &&
      ((left.identity && right.nullable) || (right.identity && left.nullable))
    )
      this.anonymousNullMatch = true
    return {
      sql: safeSql`(${left.sql} ${operator} ${right.sql})`,
      type: 'boolean',
      data: left.data || right.data,
      // IS [NOT] DISTINCT FROM is always true or false; every other operator is
      // three-valued.
      nullable: !['==', '!='].includes(node.operator) && (left.nullable || right.nullable),
    }
  }
  policy(action: Action, expression: unknown): SafeSqlFragment[] {
    const value = this.compile(parsePermission(expression))
    if (value.type !== 'boolean') throw new Error('Rule must return a boolean')
    if (value.sql.length > 1000)
      throw new Error(
        'The translated condition needs a more readable policy. Simplify it in a local migration.'
      )
    if (action === 'update' && value.data)
      throw new Error('Data-dependent updates require explicit old/new-row semantics')
    const table = qualified(this.ns)
    const predicate = value.sql
    const policy = ident(`import_${action}`)
    const statements: SafeSqlFragment[] = []
    const columns = [ident('id'), ...this.ns.columns.map((c) => ident(c.target))]
    if (action === 'view')
      statements.push(
        safeSql`CREATE POLICY ${policy} ON ${table} FOR SELECT TO anon, authenticated USING (${predicate})`,
        foreignKeysFor(this.plan, this.ns.target).length
          ? safeSql`GRANT SELECT (${joinSqlFragments(columns, ', ')}) ON TABLE ${table} TO anon, authenticated`
          : safeSql`GRANT SELECT ON TABLE ${table} TO anon, authenticated`
      )
    if (action === 'create')
      statements.push(
        safeSql`CREATE POLICY ${policy} ON ${table} FOR INSERT TO anon, authenticated WITH CHECK (${predicate})`,
        safeSql`GRANT INSERT (${joinSqlFragments(columns, ', ')}) ON TABLE ${table} TO anon, authenticated`
      )
    if (action === 'update') {
      if (!this.ns.columns.length)
        throw new Error('Table has no scalar columns that clients can update')
      statements.push(
        safeSql`CREATE POLICY ${policy} ON ${table} FOR UPDATE TO anon, authenticated USING (${predicate}) WITH CHECK (${predicate})`,
        safeSql`GRANT UPDATE (${joinSqlFragments(
          this.ns.columns.map((c) => ident(c.target)),
          ', '
        )}) ON TABLE ${table} TO anon, authenticated`
      )
    }
    if (action === 'delete')
      statements.push(
        safeSql`CREATE POLICY ${policy} ON ${table} FOR DELETE TO anon, authenticated USING (${predicate})`,
        safeSql`GRANT DELETE ON TABLE ${table} TO anon, authenticated`
      )
    return statements
  }
}

export function compilePermissions(plan: Plan) {
  const config = JSON.parse(plan.config.toString())
  const sourceRules: unknown = config.rules
  const rules: PermissionRule[] = []
  const statements: SafeSqlFragment[] = []
  const ruleStatements: Record<string, SafeSqlFragment[]> = {}
  const globals = object(sourceRules) && object(sourceRules.$default) ? sourceRules.$default : {}
  const manual = (entry: PermissionRule, reason: string) => {
    entry.status = 'manual'
    entry.reason = reason
    entry.suggestion = /[Ff]ield/.test(reason)
      ? 'Use a restricted view or server projection for conditional field visibility; validate filters and writes as well as returned values.'
      : /rateLimit/.test(reason)
        ? 'Enforce rate limits atomically in a trusted server operation; do not consume tokens inside an RLS predicate.'
        : /Native Auth/.test(reason)
          ? 'Configure Supabase Auth or Storage authorization explicitly; application table policies do not control native service operations.'
          : /[Rr]elationship|linked entities|transaction-aware/.test(reason)
            ? 'Implement a transaction or RPC that authorizes both relationship endpoints and preserves link constraints.'
            : 'Implement and test this rule in a separate policy or trusted server operation before granting access.'
  }
  /** A converted rule that is applied as written but still needs a human decision. */
  const review = (entry: PermissionRule, reason: string, suggestion: string) => {
    entry.reason = entry.reason ? `${entry.reason} ${reason}` : reason
    entry.suggestion = entry.suggestion ? `${entry.suggestion} ${suggestion}` : suggestion
  }
  for (const ns of plan.namespaces) {
    const local = object(sourceRules) && own(sourceRules, ns.source) ? sourceRules[ns.source] : {}
    const allow = object(local) && object(local.allow) ? local.allow : {}
    const globalAllow = object(globals.allow) ? globals.allow : {}
    const bindings = {
      ...(object(globals.bind) ? globals.bind : {}),
      ...(object(local) && object(local.bind) ? local.bind : {}),
    }
    const hasFields = (object(local) && own(local, 'fields')) || own(globals, 'fields')
    for (const action of actions) {
      const candidates = [
        [allow, action, `${ns.source}.allow.${action}`],
        [allow, '$default', `${ns.source}.allow.$default`],
        [globalAllow, action, `$default.allow.${action}`],
        [globalAllow, '$default', '$default.allow.$default'],
      ] as const
      const selected = candidates.find(([value, key]) => own(value, key))
      const expression = selected ? selected[0][selected[1]] : 'true'
      const entry: PermissionRule = {
        namespace: ns.source,
        target: `${ns.destination}.${ns.target}`,
        action,
        expression,
        source: selected?.[2] ?? 'implicit default (true)',
        bindings,
        status: 'converted',
      }
      rules.push(entry)
      if (ns.destination === 'excluded') {
        entry.status = 'excluded'
        entry.reason = 'Source runtime namespace is outside this migration'
        continue
      }
      try {
        if (
          !object(sourceRules) ||
          !object(local) ||
          (own(local, 'allow') && !object(local.allow)) ||
          (own(local, 'bind') && !object(local.bind)) ||
          (object(sourceRules) && own(sourceRules, '$default') && !object(sourceRules.$default)) ||
          (own(globals, 'allow') && !object(globals.allow)) ||
          (own(globals, 'bind') && !object(globals.bind))
        )
          throw new Error('Rules or bindings are missing or malformed')
        if (ns.source.startsWith('$'))
          throw new Error(
            'Native Auth and Storage operations require service-specific authorization'
          )
        const parsed = parsePermission(expression)
        if (parsed.kind === 'literal' && parsed.value === false) {
          entry.effect = 'deny'
          continue
        }
        if (
          [local, globals].some((definition) =>
            Object.keys(definition).some((key) => !['allow', 'bind', 'fields'].includes(key))
          )
        )
          throw new Error('Unknown namespace rule configuration requires review')
        if (object(globals.bind) && Object.keys(globals.bind).length)
          throw new Error('Global binding inheritance requires manual resolution')
        if (
          ['create', 'update'].includes(action) &&
          ns.columns.some((c) => c.unique && c.indexMethod === 'hash')
        )
          throw new Error(
            'A source unique attribute needs a custom constraint. Resolve it in a local migration before allowing writes.'
          )
        if (hasFields)
          throw new Error(
            'Field-level permissions require a restricted view or server operation; row policies cannot redact values'
          )
        if (
          action === 'delete' &&
          plan.links.some((l) => l.forward.on === ns.source || l.reverse.on === ns.source)
        )
          throw new Error(
            'Deleting linked entities requires explicit authorization for relationship changes and cascades'
          )
        const compiler = new Compiler(plan, ns, bindings)
        const converted = compiler.policy(action, expression)
        ruleStatements[`rule-${rules.length - 1}`] = converted
        statements.push(...converted)
        entry.effect = 'allow'
        if (!selected)
          review(
            entry,
            'No source rule matched this operation, so the implicit default granted anon and authenticated full access to this table.',
            'Add an explicit rule for this operation in the source, or replace the generated policy and grants with ones that match your access model.'
          )
        if (compiler.anonymousNullMatch)
          review(
            entry,
            'This rule compares the identity with a nullable value. NULL equals NULL in this translation; check whether other conditions exclude anonymous requests when required.',
            'Require a signed-in user in the source rule, such as `auth.id != null && ...`, or add an IS NOT NULL guard to the generated policy.'
          )
      } catch (error) {
        manual(entry, error instanceof Error ? error.message : 'Unsupported rule')
      }
    }
  }
  // Preserve every source subtree, including metadata not understood by this compiler.
  if (object(sourceRules))
    for (const [namespace, definition] of Object.entries(sourceRules)) {
      const known = plan.namespaces.some((n) => n.source === namespace) || namespace === '$default'
      if (!known || !object(definition)) {
        const entry: PermissionRule = {
          namespace,
          action: '*',
          source: namespace,
          expression: definition,
          status: 'manual',
        }
        manual(
          entry,
          known
            ? 'Malformed namespace rules'
            : 'No matching imported namespace or supported rule configuration'
        )
        rules.push(entry)
        continue
      }
      for (const [key, value] of Object.entries(definition)) {
        if (key === 'allow' && object(value)) {
          for (const [action, expression] of Object.entries(value))
            if (![...actions, '$default'].includes(action)) {
              const entry: PermissionRule = {
                namespace,
                action,
                source: `${namespace}.allow.${action}`,
                expression,
                status: 'manual',
              }
              manual(entry, 'Unknown permission operation')
              rules.push(entry)
            }
          for (const [action, expression] of Object.entries(value))
            if (
              [...actions, '$default'].includes(action) &&
              !rules.some((r) => r.source === `${namespace}.allow.${action}`)
            )
              rules.push({
                namespace,
                action,
                source: `${namespace}.allow.${action}`,
                expression,
                bindings: definition.bind,
                status: 'excluded',
                reason: 'This source rule is overridden for every imported operation',
              })
        } else if (key === 'bind' && object(value)) {
          // Bindings are source context, not independent grants. Preserve them explicitly.
          for (const [name, expression] of Object.entries(value))
            rules.push({
              namespace,
              action: `bind.${name}`,
              source: `${namespace}.bind.${name}`,
              expression,
              status: 'excluded',
              reason:
                'Binding definition retained as context; conversion is reported on each effective operation that uses it',
            })
        } else if (key === 'fields' && object(value)) {
          for (const [field, expression] of Object.entries(value)) {
            const entry: PermissionRule = {
              namespace,
              action: `fields.${field}`,
              source: `${namespace}.fields.${field}`,
              expression,
              bindings: definition.bind,
              status: 'manual',
            }
            manual(entry, 'Conditional field visibility is not row-level security')
            rules.push(entry)
          }
        } else if (!['allow', 'bind'].includes(key)) {
          const entry: PermissionRule = {
            namespace,
            action: key,
            source: `${namespace}.${key}`,
            expression: value,
            status: 'manual',
          }
          manual(entry, 'Unsupported rule configuration')
          rules.push(entry)
        }
      }
    }
  for (const link of plan.links) {
    const entry: PermissionRule = {
      namespace: link.forward.on,
      action: `link.${link.forward.label}`,
      source: `schema.links.${link.source}`,
      expression: { forward: link.forward, reverse: link.reverse },
      target: `public.${link.mapping.table}`,
      status: 'manual',
    }
    manual(
      entry,
      'Direct relationship reads and mutations require policies for the mapped foreign key or junction table'
    )
    rules.push(entry)
  }
  const guard = safeSql`BEGIN IF EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'public' AND tablename = ANY (ARRAY[${joinSqlFragments(
    publicTables(plan).map((table) => literal(table)),
    ', '
  )}]::text[])) THEN RAISE EXCEPTION 'Permission conversion requires the imported baseline without existing application policies'; END IF; END`
  const setup = [
    safeSql`DO ${literal(guard)}`,
    ...publicTables(plan).map(
      (table) => safeSql`ALTER TABLE public.${ident(table)} ENABLE ROW LEVEL SECURITY`
    ),
  ]
  return {
    version: 1,
    contentHash: plan.contentHash,
    applied: false,
    sourceRules: sourceRules ?? null,
    summary: {
      converted: rules.filter((r) => r.status === 'converted').length,
      manual: rules.filter((r) => r.status === 'manual').length,
      excluded: rules.filter((r) => r.status === 'excluded').length,
    },
    rules,
    ruleStatements,
    statements: statements.length ? [...setup, ...statements] : [],
  }
}
export function permissionsSql(report: ReturnType<typeof compilePermissions>) {
  return safeSql`BEGIN;\n${joinSqlFragments(
    report.statements.map((s) => safeSql`${s};`),
    '\n\n'
  )}\nCOMMIT;\n`
}

export function permissionsManual(report: ReturnType<typeof compilePermissions>) {
  const pending = report.rules.filter((rule) => rule.status === 'manual')
  const review = report.rules.filter((rule) => rule.status === 'converted' && rule.reason)
  return [
    '# Permissions requiring manual conversion',
    '',
    `Converted: ${report.summary.converted}. Manual: ${pending.length}. Excluded: ${report.summary.excluded}.`,
    '',
    report.applied
      ? 'Supported rules have been applied and recorded in migration history. Unsupported operations remain closed. Fetch the migrations with the Supabase CLI, then implement remaining rules in new local migrations.'
      : 'Generated SQL has not been applied. Complete the data restore first. Review permissions.sql and the entries below, then apply permissions as a separate migration. Unsupported operations remain closed. Do not resume the data import after changing policies or grants.',
    '',
    'The companion permissions.json preserves all original rules. Relationship columns and junction tables remain closed to direct client access; select explicit scalar columns instead of SELECT * on tables with foreign keys. Native Auth and Storage require service-specific policies. SQL updates and deletes also require a matching SELECT policy; INSERT RETURNING requires SELECT access.',
    '',
    ...pending.flatMap((entry, index) => [
      `## ${index + 1}`,
      '',
      ...JSON.stringify(entry, null, 2)
        .split('\n')
        .map((line) => `    ${line}`),
      '',
    ]),
    ...(review.length
      ? [
          '# Converted rules that need review',
          '',
          'These rules were converted and applied exactly as the source wrote them. Read each one before opening the application to clients.',
          '',
          ...review.flatMap((entry, index) => [
            `## ${index + 1}`,
            '',
            ...JSON.stringify(entry, null, 2)
              .split('\n')
              .map((line) => `    ${line}`),
            '',
          ]),
        ]
      : []),
  ].join('\n')
}
